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

import DownloadModel from '../../../../models/DownloadModel';
import { deserialize } from '../../../../stores/DownloadStore';
import { DownloadAction } from '../../constants/DownloadAction';
import { DownloadStatus } from '../../constants/DownloadStatus';
import { getDownloadItemActions } from '../downloadItemActions';
import { gameHtml, gameStateUri, localGamePath, prepareGameDownload } from '../offlineGame';

jest.mock('@jellyfin/sdk/lib/utils/api/user-api');
jest.mock('expo-file-system', () => ({
	documentDirectory: 'file:///documents/',
	FileSystemSessionType: { FOREGROUND: 1 },
	getInfoAsync: jest.fn(() => Promise.resolve({ exists: false })),
	makeDirectoryAsync: jest.fn(() => Promise.resolve()),
	deleteAsync: jest.fn(() => Promise.resolve()),
	downloadAsync: jest.fn(() => Promise.resolve({ status: 200 })),
	writeAsStringAsync: jest.fn(() => Promise.resolve()),
	moveAsync: jest.fn(() => Promise.resolve())
}));

const root = new URL('https://example.test/base/jellyemu/');
const manifest = {
	name: 'Sonic 2', userId: 'user', core: 'genesis_plus_gx', controlScheme: 'segaMD', runtimeRoot: '/base/jellyemu/ejs/',
	runtimeUrls: [ '/base/jellyemu/ejs/loader.js', '/base/jellyemu/ejs/cores/genesis_plus_gx-wasm.data' ],
	romUrl: '/base/jellyemu/rom/game/Sonic%202.7z?userId=user', biosUrl: null
};
const createDownload = () => new DownloadModel({ Id: 'game', ServerId: 'server', Name: 'Sonic 2', MediaType: 'Book' },
	root.origin, 'test-token', 'Sonic 2.7z', 'https://example.test/download');
const api = {
	getUri: (path: string) => new URL('/base' + path, root).href,
	authorizationHeader: 'MediaBrowser Token="test-token"',
	axiosInstance: { get: jest.fn(() => Promise.resolve({ data: manifest })) }
} as unknown as Api;

beforeEach(() => {
	jest.clearAllMocks();
	(getUserApi as jest.Mock).mockReturnValue({ getCurrentUser: () => Promise.resolve({ data: { Id: 'user' } }) });
	(FileSystem.downloadAsync as jest.Mock).mockResolvedValue({ status: 200 });
});

test('a game becomes playable only after its complete local package exists', async () => {
	const download = createDownload();
	expect(download.canPlay).toBe(false);
	await prepareGameDownload(api, download);
	expect(FileSystem.downloadAsync).toHaveBeenCalledTimes(3);
	expect(FileSystem.moveAsync).toHaveBeenCalledTimes(1);
	expect(download.canPlay).toBe(true);
	expect(download.uri).toMatch(/^file:\/\/\/documents\/GamePackages\/[^/]+\/index.html$/);
	download.status = DownloadStatus.Complete;
	const actions = getDownloadItemActions(download).filter(action => action.isSupported);
	expect(actions.find(action => action.isDefault)?.id).toBe(DownloadAction.PlayInApp);
	expect(actions.some(action => action.id === DownloadAction.OpenInFiles || action.id === DownloadAction.Share)).toBe(false);
});

test('a failed asset leaves no playable package or completed marker', async () => {
	const download = createDownload();
	(FileSystem.downloadAsync as jest.Mock).mockResolvedValueOnce({ status: 503 });
	await expect(prepareGameDownload(api, download)).rejects.toThrow('503');
	expect(download.game).toBeUndefined();
	expect(download.canPlay).toBe(false);
	expect(FileSystem.moveAsync).not.toHaveBeenCalled();
	expect(FileSystem.deleteAsync).toHaveBeenLastCalledWith(expect.stringContaining('/pending/'), { idempotent: true });
});

test('package resources cannot escape their server, base path or local directory', () => {
	for (const path of [ 'https://elsewhere.test/rom', '/private/file', '/base/jellyemu/%2fprivate', '/base/jellyemu/%5cprivate' ]) {
		expect(() => localGamePath(path, root)).toThrow();
	}
	expect(localGamePath(manifest.romUrl, root)).toBe('base/jellyemu/rom/game/Sonic%202.7z');
});

test('the player uses relative local assets and safely embeds a game title', () => {
	const html = gameHtml({ ...manifest, name: '</script><script>alert(1)</script>' }, root);
	expect(html).toContain('window.EJS_gameUrl="base/jellyemu/rom/game/Sonic%202.7z"');
	expect(html).toContain('src="base/jellyemu/ejs/loader.js"');
	expect(html).not.toContain('https://');
	expect(html).not.toContain('alert(1)</script>');
});

test('package identity and device state survive store hydration after an app restart', async () => {
	const download = createDownload();
	await prepareGameDownload(api, download);
	download.status = DownloadStatus.Complete;
	const saved = JSON.stringify({ state: { downloads: [[ download.key, download ]] } });
	const restored = deserialize(saved).state.downloads.get(download.key);
	expect(restored?.game).toEqual(download.game);
	expect(restored?.uri).toBe(download.uri);
	if (!restored?.game || !download.game) throw new Error('Missing persisted game');
	expect(gameStateUri(restored)).toBe(gameStateUri(download));
	const previous = gameStateUri(download);
	download.game.core = 'other_core';
	expect(gameStateUri(download)).not.toBe(previous);
	download.game.userId = 'other-user';
	expect(gameStateUri(download)).toContain('/other-user/');
});
