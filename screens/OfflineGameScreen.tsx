/**
 * Copyright (c) 2026 Jellyfin Contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as FileSystem from 'expo-file-system';
import { useKeepAwake } from 'expo-keep-awake';
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, StyleSheet, View } from 'react-native';
import { Button, Text } from 'react-native-elements';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import Colors from '../constants/Colors';
import type { Screens } from '../constants/Screens';
import { gameStateUri, packageUri } from '../features/downloads/utils/offlineGame';
import { useStores } from '../hooks/useStores';
import type { RootNavigatorParams } from '../navigation/RootNavigator';
import { ensurePathExists } from '../utils/File';

const OfflineGameScreen = ({ route, navigation }: NativeStackScreenProps<RootNavigatorParams, typeof Screens.OfflineGameScreen>) => {
	const { downloadStore } = useStores();
	const { t } = useTranslation();
	const webview = useRef<WebView>(null);
	const [ ready, setReady ] = useState(false);
	const [ status, setStatus ] = useState('');
	const download = downloadStore.downloads.get(route.params.downloadKey);
	useKeepAwake();
	if (!download?.game) return null;
	const root = packageUri(download.game);
	const stateUri = gameStateUri(download);
	const reportError = () => setStatus(t('downloads.game.stateFailed'));

	const onMessage = async ({ nativeEvent }: WebViewMessageEvent) => {
		try {
			const message = JSON.parse(nativeEvent.data);
			if (message.event === 'started') setReady(true);
			else if (message.event === 'state' && typeof message.data === 'string') {
				await ensurePathExists(stateUri.substring(0, stateUri.lastIndexOf('/') + 1));
				await FileSystem.writeAsStringAsync(stateUri, message.data, { encoding: FileSystem.EncodingType.Base64 });
				setStatus(t('downloads.game.saved'));
			} else if (message.event === 'loaded') setStatus(t('downloads.game.loaded'));
			else if (message.event === 'error') reportError();
		} catch { reportError(); }
	};

	const save = () => webview.current?.injectJavaScript(`
(async function(){try{
const state=await window.EJS_emulator.gameManager.getState();
if(!state || !state.byteLength)throw new Error('Empty state');
const reader=new FileReader();
reader.onload=function(){window.ReactNativeWebView.postMessage(JSON.stringify({event:'state',data:reader.result.split(',')[1]}));};
reader.onerror=function(){window.ReactNativeWebView.postMessage(JSON.stringify({event:'error'}));};
reader.readAsDataURL(new Blob([state]));
}catch(e){window.ReactNativeWebView.postMessage(JSON.stringify({event:'error'}));}})();true;`);

	const load = async () => {
		try {
			const data = await FileSystem.readAsStringAsync(stateUri, { encoding: FileSystem.EncodingType.Base64 });
			webview.current?.injectJavaScript(`
(async function(){try{
const data=atob(${JSON.stringify(data)});
await window.EJS_emulator.gameManager.loadState(Uint8Array.from(data,function(c){return c.charCodeAt(0);}));
window.ReactNativeWebView.postMessage(JSON.stringify({event:'loaded'}));
}catch(e){window.ReactNativeWebView.postMessage(JSON.stringify({event:'error'}));}})();true;`);
		} catch { setStatus(t('downloads.game.noState')); }
	};

	return (
		<SafeAreaView style={styles.container}>
			<View style={styles.controls}>
				<Button title={t('downloads.game.save')} disabled={!ready} onPress={save} />
				<Button title={t('downloads.game.load')} disabled={!ready} onPress={load} />
				<Button title={t('downloads.game.close')} onPress={() => navigation.goBack()} />
			</View>
			<Text accessibilityRole='alert' style={styles.status}>{status}</Text>
			<WebView
				ref={webview}
				source={{ uri: root + 'index.html' }}
				allowingReadAccessToURL={root}
				allowFileAccessFromFileURLs
				originWhitelist={[ 'file://*' ]}
				onShouldStartLoadWithRequest={request => request.url.startsWith(root)}
				mediaPlaybackRequiresUserAction={false}
				scrollEnabled={false}
				onMessage={onMessage}
				onError={() => Alert.alert(t('downloads.game.launchFailed'))}
			/>
		</SafeAreaView>
	);
};

const styles = StyleSheet.create({
	container: { flex: 1, backgroundColor: Colors.black },
	controls: { flexDirection: 'row', justifyContent: 'space-around' },
	status: { color: Colors.white, textAlign: 'center' }
});

export default OfflineGameScreen;
