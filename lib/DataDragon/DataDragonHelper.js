'use strict';
// TODO: integrate into LeagueJS
const fs = require('fs');
const path = require('path');
const request = require('request');
const EventEmitter = require('events');

const Bluebird = require('bluebird');
const mkdirsSync = require('node-mkdirs');
const NodeCache = require('node-cache');

const {MatchUtil} = require('../util');

/** only the languages that are actually used by realms.
 * languages contains extra locales, which are not available on dataDragon */
const localesUsedForRealms = require('./DataDragon.constants').localesUsedForRealms;
const languages = require('./DataDragon.constants').languages;
const realmToLocaleMap = require('./DataDragon.constants').realmToLocaleMap;

/**
 * Holds downloadPromises for each locale + for the download all task
 * The respective Promises will be resolved (or rejected) once the downloading process finished.
 * If a respective Promise for a locale / version is null, no download is active.
 *
 * If "all" is being used, the same promise will be set for every locale and the respective version.
 *
 * Format: {
 * 		<locale or "all"> : {
 * 				<ddragonVersion> : Promise<void> | null
 * 			}
 * 		}
 * @type {Object.<string, Object.<string, ?Bluebird>>}
 * */
let downloadPromises;
let downloadUpdatePromise;
let storageRoot = __dirname;

const cache = new NodeCache({ // TODO: replace with settable cache? (see endpoint caches or rather use StaticDataEndpoint cache)
	stdTTL: 4 * 60 * 60, // 4h
	checkperiod: 5 * 60, // 1h
	errorOnMissing: false,
	useClones: true
});

const events = new EventEmitter();

const eventIds = {
	/** emitted whenever a file was downloaded.
	 * listener will receive
	 * a message and info about the downloaded file
	 * {locale, version, path }*/
	DOWNLOAD: 'download',
	ERROR: 'error',
	/** Will be emitted for any log type, that does not have any listeners attached. */
	LOG: 'log',
	LOG_ERROR: 'log-error',
	LOG_INFO: 'log-info',
	LOG_DEBUG: 'log-debug'
};

// TODO(refactor): move events to own module
function emitDownload(locale, version, destination) {
	events.emit(eventIds.DOWNLOAD, {locale, version, path: destination});
}

function emitError(err) {
	if (events.listenerCount(eventIds.ERROR) !== 0) {
		events.emit(eventIds.ERROR, err);
	} else {
		console.error(err);
		throw err;
	}
}

function emitLog(text, ...args) {
	events.emit(eventIds.LOG, text, ...args);
}

function emitLogError(text, ...args) {
	events.emit(eventIds.LOG_ERROR, text, ...args);
	if (events.listenerCount('log-error') === 0) {
		emitLog(text, ...args);
	}
}

function emitLogInfo(text, ...args) {
	events.emit(eventIds.LOG_INFO, text, ...args);
	if (events.listenerCount('log-info') === 0) {
		emitLog(text, ...args);
	}
}

function emitLogDebug(text, ...args) {
	events.emit(eventIds.LOG_DEBUG, text, ...args);
	if (events.listenerCount('log-debug') === 0) {
		emitLog(text, ...args);
	}
}


function reset() {
	downloadPromises = {all: {}};
	languages.forEach(locale => {
		downloadPromises[locale] = {};
	});

	downloadUpdatePromise = null;
	storageRoot = __dirname;

	cache.flushAll();

	events.removeAllListeners();
}

reset();

class DataDragonHelper {
	static get events() {
		return events;
	}

	static get eventIds() {
		return eventIds;
	}

	static get realmToLocaleMap() {
		return realmToLocaleMap;
	}

	static get languages() {
		return languages;
	}

	static get localesForRealms() {
		return localesUsedForRealms;
	}

	static get storageRoot() {
		return storageRoot;
	}

	static set storageRoot(pathSegmentsArrayOrPathString) {
		if (Array.isArray(pathSegmentsArrayOrPathString)) {
			storageRoot = path.resolve(...pathSegmentsArrayOrPathString);
		} else {
			storageRoot = path.resolve(pathSegmentsArrayOrPathString);
		}
		emitLogInfo('setting storageRoot to ' + storageRoot);
		console.log('setting storageRoot to ' + storageRoot);
		ensureDirectoryExistence(storageRoot);
	}

	static reset() {
		reset();
	}

	static buildStoragePath({version, locale}) {
		if (!version) {
			emitError(new Error('buildStoragePath: no version provided'));
		}
		if (!locale) {
			emitError(new Error('buildStoragePath: no locale provided'));
		}
		return path.resolve(DataDragonHelper.storageRoot, version, locale);
	}

	static get URL_DDRAGON_CDN() {
		return 'http://ddragon.leagueoflegends.com/cdn';
	}

	static get URL_CDRAGON_PERKS() {
		return 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/perks.json';
	}

	// TODO: download and extract TAR??
	// link: https://ddragon.leagueoflegends.com/cdn/dragontail-7.20.3.tgz

	static get URL_DDRAGON_VERSIONS() {
		return 'https://ddragon.leagueoflegends.com/api/versions.json';
	}

	static get URL_DDRAGON_REALMS() {
		return 'https://ddragon.leagueoflegends.com/api/realms.json';
	}

	static get URL_DDRAGON_LANGUAGES() {
		return 'http://ddragon.leagueoflegends.com/cdn/languages.json';
	}

	static getPerkImageUrl(perkId) {
		// cdragon url
		return `http://stelar7.no/cdragon/latest/perks/${perkId}.png`;
	}

	static getDDragonRealmUrl(realm) {
		return `https://ddragon.leagueoflegends.com/realms/${realm}.json`;
	}

	static getDdragonImgUrl({type, version, name}) {
		return `${DataDragonHelper.URL_DDRAGON_CDN}/${version}/img/${type}/${name}`;
	}

	static gettingVersions() {
		return requestingCached(DataDragonHelper.URL_DDRAGON_VERSIONS, 'versions');
	}

	static gettingRealms() {
		return requestingCached(DataDragonHelper.URL_DDRAGON_REALMS, 'realms');
	}

	static gettingRealmInfo(realm) {
		return requestingCached(DataDragonHelper.getDDragonRealmUrl(realm), 'realm/' + realm);
	}

	static downloadingStaticDataByVersion({version, locales} = {}) {
		locales = locales || ['en_US'];
		if (!version) {
			emitError(new Error('downloadingStaticDataByVersion: version is invalid, received: ' + version));
		}
		return Bluebird.map(locales, (locale) => {
			const isAlreadyLoaded = fs.existsSync(path.resolve(DataDragonHelper.buildStoragePath({
				version,
				locale
			})));
			if (isAlreadyLoaded) {
				return true;
			} else {
				return downloadingStaticDataFiles(locale, version).then(() => {
					console.log('New Static Data assets were downloaded for: ' + locale + ' ' + version);

					emitDownload(locale, version, DataDragonHelper.buildStoragePath({locale, version}));
					return {version, locale};
				});
			}
		}, {concurrency: 1});
	}

	static downloadingStaticDataByLocale(locale, versions = [], minimumMajorVersion = 8) {
		const versionsToLoad = getMissingVersionsFromDownloads(versions, minimumMajorVersion, locale);
		if (versionsToLoad.length === 0) {
			return Bluebird.resolve([]);
		}

		return Bluebird.map(versionsToLoad, (version) => {
			if (downloadPromises.all[version]) {
				return downloadPromises.all[version];
			}
			if (downloadPromises[locale][version]) {
				return downloadPromises[locale][version];
			}
			return downloadingStaticDataFiles(locale, version)
				.then(() => {
					console.log('New Static Data assets were downloaded for: ' + locale + ' ' + version);

					emitDownload(locale, version, DataDragonHelper.buildStoragePath({locale, version}));

					return versionsToLoad;
				})
				.finally(() => {
					delete downloadPromises[locale][version];
				});

		}, {concurrency: 1});
	}

	/**
	 * Downloads static data for given locale and ALL versions
	 * */
	static downloadingStaticData(locale) { // TODO(refactor): rename to updating or something
		if (downloadUpdatePromise !== null) {
			return downloadUpdatePromise;
		}

		downloadUpdatePromise = DataDragonHelper.gettingVersions()
			.then(versions => {
				return DataDragonHelper.downloadingStaticDataByLocale(locale, versions);
			}).catch((err) => {
				console.warn('Error while downloading static-data', err);

				emitError(err);

			}).finally(() => {
				downloadUpdatePromise = null;
			});

		return downloadUpdatePromise;
	}

	// TODO: add method gettingLatestVersionFromDD

	static gettingLatestVersionFromDownloads(locale) {
		// TODO(fix): latest from Downloads might not be downloaded for locale yet, or new version might be available
		// currently it's safest to regularly check for new versions and download the needed locales independently

		return DataDragonHelper.gettingVersionsFromDownloads().then(versions => {
			return versions.sort(MatchUtil.sortVersionsDescending);
		}).then(versionsDescending => {
			if (versionsDescending.length === 0) {
				emitError(new Error('no downloaded versions available'));
			}
			if (!locale) {
				return versionsDescending[0];
			} else {
				return findingDownloadedVersionOfLocale(DataDragonHelper.storageRoot, versionsDescending, 0, locale);
			}
		}).then((ddV) => {
			emitLogDebug(`Latest ddv in downloads${locale ? ' for ' + locale : ''}:`, ddV);
			return ddV;
		});
	}

	// TODO(feat): add gettingLatestDownloadedVersionWithLocale
	// TODO(feat): add gettingLatestDownloadedVersionsWithLocale

	static gettingVersionsFromDownloads() { // TODO(feat): add locale support
		return new Bluebird((resolve, reject) => {
			fs.readdir(DataDragonHelper.storageRoot, (err, files) => {
				if (err) {
					return reject(err);
				}

				resolve(files.filter(filename => {
					return !filename.includes('.js');
				}));
			});
		});
	}

	/**
	 * @see https://developer.riotgames.com/api-methods/#lol-static-data-v3/GET_getItemList
	 * @param ddV
	 * @param locale
	 */
	static gettingItemList(ddV, locale) {
		// TODO: add options filtering? Better add to LeagueJS.StaticData refactoring
		return gettingLocalList(ddV, 'item', locale);
	}

	/**
	 * @see https://developer.riotgames.com/api-methods/#lol-static-data-v3/GET_getItemList
	 * @param ddV
	 * @param locale
	 */
	static gettingReforgedRunesList(ddV, locale) { // TODO(refactor): rename to perks!?
		// make sure 8.1 is used for patches that have perks enabled, but no ddragon data available
		if (ddV.indexOf('7.23') >= 0) {
			ddV = '8.1.1';
		}
		return gettingLocalList(ddV, 'runesReforged', locale).catch((err) => {
			emitLogError('Error in RiotAppiHelper.gettingRunesList()', {locale, ddV, err});
			emitError(err);
		});
	}

	/**
	 * Gets the 'championFull' file.
	 * @param ddV
	 * @param locale
	 * @return {*}
	 */
	static gettingFullChampionsList(ddV, locale) {
		return gettingLocalList(ddV, 'championFull', locale);
	}

	/**
	 * Gets all champions (summary file).
	 * Use gettingFullChampionsList for the complete data.
	 * Champion data contains:
	 * - version
	 * - id
	 * - key
	 * - name
	 * - title
	 * - blurb
	 * - info
	 * - image
	 * - tags
	 * - partype
	 * - stats
	 *
	 * For additional data use {@see #gettingFullChampionsList()}
	 * @param ddV
	 * @param locale
	 * @returns {Array.<{id:number, name:string}>}
	 */
	static gettingChampionsList(ddV, locale) { // TODO: remove platform and options?!)
		emitLogDebug('gettingChampionsList() for region %s', ddV, locale);
		return gettingLocalList(ddV, 'champion', locale).catch((err) => {
			emitLogError('Error in gettingChampionsList()', {ddV, locale, err});
			emitError(err);
		});
	}

	/**
	 * @param ddV
	 * @param locale
	 * @returns {Array.<{id:number, name:string}>}
	 */
	static gettingSummonerSpellsList(ddV, locale) { // TODO: remove platform and options?!
		emitLogDebug('getAllSummonerSpells() for region %s', locale, ddV);

		return gettingLocalList(ddV, 'summoner', locale).catch((err) => {
			emitLogError('Error in getAllSummonerSpells()', {locale, ddV, options, err});
			emitError(err);
		});
	}

	static gettingMasteryList(ddV, locale) {
		return gettingLocalList(ddV, 'mastery', locale);
	}

	static gettingRuneList(ddV, locale) {
		return gettingLocalList(ddV, 'rune', locale);
	}

	static gettingProfileiconList(ddV, locale) {
		return gettingLocalList(ddV, 'profileicon', locale);
	}

	static gettingLatestVersion() {
		return DataDragonHelper.gettingVersions().then(versions => versions.sort(MatchUtil.sortVersionsDescending)[0]);
	}
}

/**
 *
 * @param version
 * @param type {string} "champion" | "item" | "mastery" | "profileicon" | "rune" | "summoner"
 * @param locale language to get the data for
 */
function gettingLocalList(version, type, locale = 'en_US', skipLatestVersionFallback = false) {
	if (!type) {
		emitError(new Error('gettingLocalList: type is invalid. Expecting string, received: ' + type));
	}
	let versionPromise;

	if (version) {
		versionPromise = Bluebird.resolve(version);
	} else {
		versionPromise = DataDragonHelper.gettingLatestVersion();
	}
	let wasLatestVersionUsed = !!version;

	return versionPromise
		.then((ddV) => {
			// trying to download files if neccessary
			return DataDragonHelper
				.downloadingStaticDataByVersion({version: ddV, locales: [locale]})
				.then(() => ddV);
		})
		.then((ddV) => {
			return new Promise((resolve, reject) => {
				const filePath = path.join(DataDragonHelper.buildStoragePath({
					version: ddV,
					locale
				}), '/', type + '.json');

				fs.readFile(filePath, 'utf8', (err, fileContent) => {
					if (!err) {
						const content = JSON.parse(fileContent);
						resolve((type === 'runesReforged') ? content : content.data);
					} else {
						if (!err.message.includes('ENOENT')) {
							emitError(err);
							reject(err);
							return null;
						}
						if (!wasLatestVersionUsed && !skipLatestVersionFallback) {
							// we did not use the latest available version yet, so let's try that
							gettingLocalList(null, type, locale)
								.then(resolve).catch(reject);
							return null;
						}

						if (wasLatestVersionUsed && !skipLatestVersionFallback) {
							// we did already fall back to the most recent version,
							// let's try to find ANY working data file from already downloaded files
							DataDragonHelper.gettingLatestVersionFromDownloads(locale).then(ddV => gettingLocalList(ddV, type, locale, true))
								.then(resolve).catch(reject);
							return null;
						}

						// otherwise we give up now
						reject(new Error('Could not receive data for ' + locale + ' ' + type));


						// TODO(improve): here, it might still happen, that the most recent working file is not downloaded yet, so for a bullet-proof approach,
						// we would need to try to find it within each version given from the ddragon versions-array (descending, starting with the version that we initially put in)
						// e.g. we started with 8.5.1 as input were not able to load the files, we then should try to download and deliver files from 8.4.1 and so on
						// currently, it would happen that we are not able to deliver 8.5.1 and then just deliver the absolute newest file (e.g. 8.14.1), which might include changes we don't want to deliver.
						// This should be an extreme edge case though, so might or might not try to solve this. Generally, two use-cases should be most common:
						// 1) just trying to get the latest files
						// 2) trying to get a specific version (derived from either the versions array, or a matchHistory or other historical data with access to the respective ddV)
						// So the automatic fix should not be neccessary, but as mentioned, using the absolute latest version as fallback might lead to unexpected results.
						// Most likely scenario when this might happen is when a lot of different versions are downloaded in short amount of time, and the ddragon cdn times out or something,
						// which would lead to the download-promise rejecting and the newest version being used.
					}
				});
			});
		});
}

function ensureDirectoryExistence(filePath) {
	const dirname = !!path.extname(filePath) ? path.dirname(filePath) : filePath;
	if (fs.existsSync(dirname)) {
		return true;
	}
	mkdirsSync(dirname);
}

function requestingCached(url, cacheKey) {
	return new Bluebird((resolve, reject) => {
		const cachedValue = cache.get(cacheKey);
		if (cachedValue) {
			resolve(cachedValue);
		} else {
			request.get(url, (err, httpResponse, body) => {
				if (err) {
					console.log(err);
					reject(err);
				} else {
					cache.set(cacheKey, JSON.parse(body));
					resolve(JSON.parse(body));
				}
			});
		}
	});
}

function writeJsonAndResolve(json, dest, resolve) {
	const content = JSON.stringify(json);

	ensureDirectoryExistence(dest);
	fs.writeFile(dest, content, 'utf8', () => {
		resolve();
	});
	return content;
}

function fixPropertiesKeyAndId(json) {
	Object.keys(json.data).forEach(dataKey => {
		const obj = json.data[dataKey];

		if (obj.key && parseInt(obj.key) >= 0) {
			// if the key is numerical, this means key and id needs to be switched.
			// safety measure in case they fix this at any point
			const id = parseInt(obj.key);
			const key = obj.id;
			json.data[dataKey].id = id;
			json.data[dataKey].key = key;
		} else if (!obj.id && parseInt(dataKey) >= 0) {
			// data items ids are used as key on the object and they might not have an id property
			json.data[dataKey].id = parseInt(dataKey);
		} else {
			json.data[dataKey].id = parseInt(json.data[dataKey].id);
		}
	});
}

function getMissingVersionsFromDownloads(versions, minimumMajorVersion, locale) {
	return versions.filter(version => {
		return parseInt(version) >= minimumMajorVersion;
	}).filter(version => {
		// version not already downloaded
		return !fs.existsSync(path.resolve(DataDragonHelper.buildStoragePath({version, locale})));
	});
}

// TODO(improvement): a file should be written with the latest, available version of each locale, for better tracking of latest available version and possibly missing versions
function downloadingStaticDataFiles(locale, version) {
	if (!locale || !version) {
		emitError(new Error('locale or version is invalid, received locale: ' + locale + ' version: ' + version));
	}

	// NOTE: locale not relevant for
	// profileicon
	//

	if (downloadPromises[locale][version]) {
		return downloadPromises[locale][version];
	}

	const profileIconUri = `${DataDragonHelper.URL_DDRAGON_CDN}/${version}/data/${locale}/profileicon.json`;
	const championUri = `${DataDragonHelper.URL_DDRAGON_CDN}/${version}/data/${locale}/champion.json`;
	const championFullUri = `${DataDragonHelper.URL_DDRAGON_CDN}/${version}/data/${locale}/championFull.json`;
	const itemUri = `${DataDragonHelper.URL_DDRAGON_CDN}/${version}/data/${locale}/item.json`;
	const summonerUri = `${DataDragonHelper.URL_DDRAGON_CDN}/${version}/data/${locale}/summoner.json`;

	/** added with 7.24 */
	const runesReforgedUri = `${DataDragonHelper.URL_DDRAGON_CDN}/${version}/data/${locale}/runesReforged.json`;

	const uriArray = [
		profileIconUri,
		championUri,
		championFullUri,
		itemUri,
		summonerUri
	];

	const [major, minor, patch] = version.match(/\d+/g).map(s => parseInt(s));
	// account for removal of runes and masteries with 7.24
	if (major >= 8) {
		uriArray.push(runesReforgedUri);
	}

	const downloadPromisesTemp = uriArray.map(uri => {
		return new Bluebird((resolve, reject) => {
			const filename = uri.substr(uri.lastIndexOf('/') + 1);
			const dest = path.resolve(DataDragonHelper.buildStoragePath({
				version,
				locale
			}) + '/' + filename);
			console.log('requestPath: ' + uri);
			console.log('downloadPath: ' + dest);
			request(uri, (err, httpResponse, body) => {
				if (err) {
					reject(err);
					return;
				}

				let json;
				try {
					json = JSON.parse(body);
				} catch (e) {
					console.error(e, locale, version, uri, dest);
					return resolve();
				}

				if (uri !== runesReforgedUri) {
					fixPropertiesKeyAndId(json);
					return writeJsonAndResolve(json, dest, resolve);
				} else {
					// In Ddragon files before 8.9.1 perks desc and longDesc contains Client placeholders for values,
					// which we can replace from the cdragon files
					// for later versions, we don't need to do that
					// TODO: should we simply use cdragon files anyways?
					if (major !== 8 || minor >= 8) { // 8.<9.y
						return writeJsonAndResolve(json, dest, resolve);
					}

					request(DataDragonHelper.URL_CDRAGON_PERKS, (errRunesCdragon, httpResponseRunesCdragon, bodyRunesCdragon) => {
						if (errRunesCdragon) {
							reject(errRunesCdragon);
							return;
						}

						let jsonCdragon = JSON.parse(bodyRunesCdragon);

						json.forEach(item => {
							item.slots.forEach(slot => {
								slot.runes.forEach(rune => {
									const runeCDragon = jsonCdragon.find(item => {
										return item.id === rune.id;
									});
									if (!runeCDragon) {
										const message = 'CDragon is missing rune: ' + rune.id + '\r\n' + 'Not updating description within ddragon version: ' + version;
										emitLogError(message);
									} else {
										rune.shortDesc = runeCDragon.shortDesc;
										rune.longDesc = runeCDragon.longDesc;
									}
								});
							});
						});

						return writeJsonAndResolve(json, dest, resolve);
					});
				}
			});
		});
	});

	downloadPromises[locale][version] = Bluebird.all(downloadPromisesTemp).finally(() => {
		delete downloadPromises[locale][version];
	});
	return downloadPromises[locale][version];
}

function findingDownloadedVersionOfLocale(rootPath, versionsDescending, i, locale) {
	return new Bluebird((resolve, reject) => {
		fs.readdir(path.join(rootPath, '/', versionsDescending[i]), (err, files) => {
			if (!err && files && files.includes(locale)) {
				return resolve(versionsDescending[i]);
			}

			i++;
			if (i === versionsDescending.length) {
				return reject(new Error('No downloaded version available for given locale: ' + locale));
			}
			return resolve(findingDownloadedVersionOfLocale(rootPath, versionsDescending, i, locale));
		});
	});
}

module.exports = DataDragonHelper;