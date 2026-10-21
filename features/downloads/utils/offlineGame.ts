/**
 * Copyright (c) 2026 Jellyfin Contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { Api } from '@jellyfin/sdk/lib/api';
import { getUserApi } from '@jellyfin/sdk/lib/utils/api/user-api';
import * as FileSystem from 'expo-file-system';
import { v4 as uuidv4 } from 'uuid';

import type DownloadModel from '../../../models/DownloadModel';
import { ensurePathExists } from '../../../utils/File';

export interface OfflineGame {
	packagePath: string;
	userId: string;
	core: string;
}

export interface GameManifest {
	name: string;
	userId: string;
	core: string;
	controlScheme: string;
	runtimeRoot: string;
	runtimeUrls: string[];
	romUrl: string;
	biosUrl?: string | null;
}

export const packageUri = (game: OfflineGame) => `${FileSystem.documentDirectory}${game.packagePath}`;

export const gameStateUri = (download: DownloadModel) => {
	if (!download.game) throw new Error('Not an offline game');
	const ids = [ download.item.ServerId, download.game.userId, download.item.Id, download.game.core ];
	if (ids.some(id => !/^[a-zA-Z0-9_-]+$/.test(id))) throw new Error('Invalid game identity');
	return `${FileSystem.documentDirectory}GameStates/${ids.map(encodeURIComponent).join('/')}.state`;
};

export const localGamePath = (value: string, root: URL): string => {
	const url = new URL(value, root);
	if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
		throw new Error('Game files must belong to this JellyEmu server');
	}
	if (url.pathname.split('/').some(part => /(^\.{1,2}$|[\\/])/.test(decodeURIComponent(part)))) {
		throw new Error('Invalid game file path');
	}
	return url.pathname.substring(1);
};

const scriptValue = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

export const gameHtml = (manifest: GameManifest, root: URL): string => {
	const dataPath = localGamePath(manifest.runtimeRoot, root);
	const gamePath = localGamePath(manifest.romUrl, root);
	const biosPath = manifest.biosUrl ? localGamePath(manifest.biosUrl, root) : '';
	return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>html,body,#game{margin:0;width:100%;height:100%;background:#000;overflow:hidden}</style></head>
<body><div id="game"></div><script>
window.EJS_player='#game';
window.EJS_core=${scriptValue(manifest.core)};
window.EJS_controlScheme=${scriptValue(manifest.controlScheme)};
window.EJS_gameName=${scriptValue(manifest.name)};
window.EJS_gameUrl=${scriptValue(gamePath)};
window.EJS_biosUrl=${scriptValue(biosPath)};
window.EJS_pathtodata=${scriptValue(dataPath)};
window.EJS_startOnLoaded=true;
window.EJS_language='en-US';
window.EJS_Buttons={saveState:false,loadState:false,saveSavFiles:false,loadSavFiles:false};
window.EJS_onGameStart=function(){window.ReactNativeWebView.postMessage(JSON.stringify({event:'started'}));};
</script><script src="${dataPath}loader.js"></script></body></html>`;
};

export const prepareGameDownload = async (api: Api, download: DownloadModel) => {
	const { data: user } = await getUserApi(api).getCurrentUser();
	if (!user.Id) throw new Error('Sign in to download games');
	const { data: manifest } = await api.axiosInstance.get<GameManifest>(
		api.getUri(`/jellyemu/offline/${download.item.Id}/manifest`),
		{ headers: { Authorization: api.authorizationHeader }, params: { userId: user.Id } }
	);
	if (manifest.userId !== user.Id || !/^[a-z0-9_]+$/.test(manifest.core)) throw new Error('Invalid game manifest');
	const root = new URL(api.getUri('/jellyemu/'));
	const files = [ ...manifest.runtimeUrls, manifest.romUrl, ...(manifest.biosUrl ? [ manifest.biosUrl ] : []) ];
	const paths = files.map(url => localGamePath(url, root));
	const dataPath = localGamePath(manifest.runtimeRoot, root);
	if (!paths.includes(`${dataPath}loader.js`) || !paths.some(path => path.endsWith('.data'))) {
		throw new Error('The server is missing the emulator runtime');
	}
	if (!/^[a-zA-Z0-9_-]+$/.test(download.key)) throw new Error('Invalid download identity');
	const pending = `GamePackages/pending/${download.key}/`;
	const pendingUri = `${FileSystem.documentDirectory}${pending}`;
	const packagePath = `GamePackages/${uuidv4()}/`;
	try {
		await FileSystem.deleteAsync(pendingUri, { idempotent: true });
		for (let i = 0; i < files.length; i++) {
			const uri = pendingUri + paths[i];
			await ensurePathExists(uri.substring(0, uri.lastIndexOf('/') + 1));
			const response = await FileSystem.downloadAsync(new URL(files[i], root).href, uri, {
				sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
				headers: { Authorization: api.authorizationHeader }
			});
			if (response.status !== 200) throw new Error(`Game file download failed (${response.status})`);
		}
		await FileSystem.writeAsStringAsync(pendingUri + 'index.html', gameHtml(manifest, root));
		await FileSystem.moveAsync({ from: pendingUri, to: `${FileSystem.documentDirectory}${packagePath}` });
		download.game = { packagePath, userId: user.Id, core: manifest.core };
		download.canPlay = true;
	} catch (err) {
		await FileSystem.deleteAsync(pendingUri, { idempotent: true });
		throw err;
	}
};
