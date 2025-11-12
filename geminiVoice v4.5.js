// ==UserScript==
// @name         Gemini to VOICEVOX
// @namespace    https://bsky.app/profile/neon-ai.art
// @homepage     https://bsky.app/profile/neon-ai.art
// @version      4.5
// @description  Geminiのお返事を、VOICEVOXと連携して自動読み上げ！
// @author       ねおん
// @match        https://gemini.google.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addStyle
// @connect      localhost
// @license      CC BY-NC 4.0
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = '4.5';
    const STORE_KEY = 'gemini_voicevox_config';

    // ========= グローバルな再生・操作制御変数 =========
    let currentAudio = null;
    let currentXhr = null; // 合成中のXHRを保持（中断用）
    let currentSpeakerNameXhr = null; // スピーカー名取得用のXHR
    let isPlaying = false;
    let lastAutoPlayedText = ''; // 最後に自動再生したテキストをキャッシュ

    // ========= 永続化された設定値の読み込み =========
    let config = GM_getValue(STORE_KEY, {
        speakerId: 4,
        apiUrl: 'http://localhost:50021',
        autoPlay: true,
        minTextLength: 10,
        shortcutKey: 'Ctrl+Shift+V'
    });

    let debounceTimerId = null;
    const DEBOUNCE_DELAY = 1000;

    let settingsMenuId = null;

    // スタイル定義 (GM_addStyle)
    GM_addStyle(`
        #mei-settings-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.7);
            z-index: 99999;
        }
        #mei-settings-panel {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background-color: #333; /* Dark background */
            padding: 25px;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            width: 90%;
            max-width: 560px;
            color: #e8eaed; /* Light text */
        }
        .mei-input-field {
            width: 100%;
            padding: 8px 10px;
            margin-top: 5px;
            border: 1px solid #5f6368;
            border-radius: 4px;
            box-sizing: border-box;
            background-color: #202124; /* Darker input background */
            color: #e8eaed;
            font-size: 14px;
        }
        .mei-input-field:focus {
            border-color: #8ab4f8;
            outline: none;
        }
        .mei-button-primary {
            padding: 8px 15px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
            background-color: #8ab4f8; /* Blue button */
            color: #202124;
        }
        .mei-button-secondary {
            padding: 8px 15px;
            border: 1px solid #5f6368;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
            background-color: #333;
            color: #e8eaed;
        }
    `);

    // ========= トーストメッセージを表示する関数 =========
    function showToast(msg, isSuccess) {
        const toastId = 'hgf-toast-mei';
        console.log(`[TOAST] ${msg}`);

        // 既存のトーストはすぐに削除
        const existingToast = document.getElementById(toastId);
        if (existingToast) {
            existingToast.remove();
        }

        // 20ms遅延させて、重いDOM操作中のレンダリング競合を回避
        setTimeout(() => {
            const toast = document.createElement('div');
            toast.textContent = msg;
            toast.id = toastId;
            toast.classList.add('hgf-toast');

            let bgColor;
            if (isSuccess === true) {
                bgColor = '#007bff';
            } else if (isSuccess === false) {
                bgColor = '#dc3545';
            } else {
                bgColor = '#6c757d';
            }

            toast.style.cssText = `
                position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
                background: ${bgColor}; color: white; padding: 10px 20px;
                border-radius: 6px; z-index: 100000;
                font-size: 14px; transition: opacity 1.0s ease, transform 1.0s ease; opacity: 0;
            `;
            document.body.appendChild(toast);

            // フェードインアニメーションを起動
            setTimeout(() => {
                toast.style.opacity = '1';
                toast.style.transform = 'translate(-50%, -20px)';
            }, 10);

            // 自動非表示ロジック
            if (isSuccess !== null) {
                setTimeout(() => {
                    toast.style.opacity = '0';
                    toast.style.transform = 'translate(-50%, 0)';
                    setTimeout(() => {
                        if (document.body.contains(toast)) {
                            toast.remove();
                        }
                    }, 1000);
                }, 3000);
            }
        }, 20);
    }

    // 再生・合成中の処理をすべてリセットし、ボタンを初期状態に戻す関数
    function resetOperation(button, isStopRequest = false) {
        // 1. Audioリセット
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.src = '';
            currentAudio = null;
        }
        isPlaying = false;

        // 2. XHR/合成リセット（中断）
        if (currentXhr) {
            currentXhr.abort(); // リクエストを中断
            currentXhr = null;
            if (isStopRequest) {
                showToast('音声合成を中断したわ！', false);
            }
        }

        // 3. ボタンリセット
        if (button) {
            button.textContent = '🔊 再生';
            button.style.backgroundColor = '#007bff';
            button.style.color = 'white';
            button.disabled = false;
            button.removeEventListener('click', stopConversion);
            button.addEventListener('click', startConversion);
        }

        // サンプルボタンが合成中・再生中だった場合もリセット
        const sampleButton = document.getElementById('mei-sample-play-btn');
        if(sampleButton && sampleButton.textContent === '■ 再生停止') {
             resetSampleButtonState(sampleButton);
        } else if (sampleButton && sampleButton.textContent === '⏱ 合成中...') {
             resetSampleButtonState(sampleButton);
        }
    }

    // 停止処理
    function stopConversion() {
        const button = document.getElementById('convertButton');
        if (isPlaying || currentXhr) {
             // 再生中または合成中の停止
             showToast('音声再生を停止したわ！', false);
             resetOperation(button, true); // trueで合成中断メッセージはresetOperationに任せる
        } else {
            // 念のためリセット
            resetOperation(button);
        }
    }

    // 特定のクラス名に依存せず、操作ボタンを子孫に持つ祖先を動的に探索するロジックを強化
    function addConvertButton() {
        const buttonId = 'convertButton';
        const wrapperId = 'convertButtonWrapper';
        let button = document.getElementById(buttonId);
        let wrapper = document.getElementById(wrapperId);

        // .response-container のすべてを取得し、配列の最後の要素を使う
        const allResponseContainers = document.querySelectorAll('.response-container');
        if (allResponseContainers.length === 0) return;

        const lastAnswerPanel = allResponseContainers[allResponseContainers.length - 1];

        // 挿入ターゲットの Flexコンテナ本体 (.buttons-container-v2) を取得
        const buttonsContainer = lastAnswerPanel.querySelector(
            '.response-container-footer .actions-container-v2 .buttons-container-v2'
        );
        if (!buttonsContainer) {
            return;
        }

        // 挿入の基準点となるスペーサー (.spacer) を取得
        const spacer = buttonsContainer.querySelector('.spacer');
        if (!spacer) {
            console.log("Gemini Voice: スペーサーが見つかりませんでした。");
            return;
        }

        if (buttonsContainer && spacer) {
            if (!wrapper) {
                // ラッパーを作成 (Flex Itemとして機能させるため)
                wrapper = document.createElement('div');
                wrapper.id = wrapperId;

                button = document.createElement('button');
                button.id = buttonId;
                // v3.5のカスタムCSSを適用
                button.style.cssText = 'padding: 5px 10px; background-color: #007bff; color: white; border: none; border-radius: 5px; cursor: pointer; margin-left: 4px;';

                resetOperation(button);

                wrapper.appendChild(button);
            } else {
                button = document.getElementById(buttonId);
                if (!button) return;
            }

            // ボタン群の最後尾（spacerの直前）にラッパーを挿入
            buttonsContainer.insertBefore(wrapper, spacer);
            // console.log("Gemini Voice: 読み上げボタンを挿入しました。ターゲット:", buttonsContainer.id || buttonsContainer.tagName);
        } else {
            console.log("ターゲット要素またはスペーサーが見つかりませんでした。");
            return;
        }

        // ボタンの状態更新ロジック
        if (currentXhr) {
            // 合成中の状態
            button.textContent = '⏱ 合成中...';
            button.style.backgroundColor = '#6c757d';
            button.disabled = false;
            button.removeEventListener('click', startConversion);
            button.addEventListener('click', stopConversion);
        } else if (isPlaying) {
            // 再生中の状態
            button.textContent = '■ 停止';
            button.style.backgroundColor = '#dc3545';
            button.disabled = false;
            button.removeEventListener('click', startConversion);
            button.addEventListener('click', stopConversion);
        } else {
            // 停止中の状態
            button.textContent = '🔊 再生';
            button.style.backgroundColor = '#007bff';
            button.disabled = false;
            button.removeEventListener('click', stopConversion);
            button.addEventListener('click', startConversion);
        }
    }

    function getGeminiAnswerText(){
        const allResponseContainer = document.querySelectorAll('.response-container');
        if (allResponseContainer.length === 0) return '';

        const textContainer = allResponseContainer[allResponseContainer.length - 1];
        if (!textContainer) return '';

        const clonedContainer = textContainer.cloneNode(true);
        const isProcessingState = clonedContainer.querySelector('.processing-state');
        const buttonWrapper = clonedContainer.querySelector('#convertButtonWrapper');
        if (buttonWrapper) {
            buttonWrapper.remove();
        }
        const loadingElement = clonedContainer.querySelector('.gpi-static-text-loader');
        if (loadingElement) {
            loadingElement.remove();
        }
        const avatarGutter = clonedContainer.querySelector('.avatar-gutter');
        if (avatarGutter) {
            avatarGutter.remove();
        }
        const sourceButton = clonedContainer.querySelector('.legacy-sources-sidebar-button');
        if (sourceButton) {
            sourceButton.remove();
        }
        const codeElements = clonedContainer.querySelectorAll('pre, code, code-block');
        codeElements.forEach(code => code.remove());

        // 🌟 V4.4 デバッグコードの追加: 「お待ちください」検出時にDOM構造を出力
        /*
        const rawText = clonedContainer.innerText || '';
        if (rawText.includes('お待ちください')) {
            console.warn("🔊 デバッグ情報: 「お待ちください」が検出されました。この時点のDOM構造を出力します。");

            // 検出された回答パネル（クローン）のouterHTMLを出力。
            // これで「お待ちください」を囲んでいる要素のクラス名や構造がわかるわ！
            console.log("【検出された回答パネルのHTML】(innerText: '" + rawText.substring(0, 50).replace(/\n/g, ' ') + "...')");
            console.log(clonedContainer.outerHTML);

            // 5階層上の要素のタグとクラス名だけを表示
            let targetElement = clonedContainer;
            let parentInfo = '';
            for (let i = 0; i < 5; i++) {
                if (targetElement.parentElement) {
                    targetElement = targetElement.parentElement;
                    parentInfo += targetElement.tagName + (targetElement.className ? '.' + targetElement.className.split(' ').join('.') : '') + ' > ';
                } else {
                    break;
                }
            }
            console.log("【親階層情報】(5階層まで): " + parentInfo.slice(0, -3));

            // ★★★ デバッグ情報収集後、この処理は必ず削除すること！ ★★★
        }
        */

        let text = clonedContainer.innerText || '';

        // 1. コードブロック、コメント、タイトル記号の除去
        text = text.replace(/```[a-z]*[\s\S]*?```|\/\/.*|^\s*[#*]+\s/gim, ' ');
        // 2. その他のマークダウン記号の除去 (ここは現状維持で良さそう)
        text = text.replace(/(\*{1,2}|_{1,2}|~{1,2}|#|\$|>|-|\[.*?\]\(.*?\)|`|\(|\)|\[|\]|<|>|\/|\\|:|\?|!|;|=|\+|\|)/gim, ' ');
        // 3. 連続する句読点や空白の調整 (ここは現状維持で良さそう)
        text = text.replace(/([\.\!\?、。？！]{2,})/g, function(match, p1) {
            return p1.substring(0, 1);
        });
        text = text.replace(/(\s{2,})/g, ' ').trim();

        if (isProcessingState) {
            return '';
        }
        if (text.startsWith('お待ちください')) {
            return '';
        }
        if (text.includes('Analyzing input...') || text.includes('Generating response...')) {
            return '';
        }

        return text;
    }

    // synthesizeAudio (Audioオブジェクトの保持とボタン状態の変更)
    function synthesizeAudio(audioQuery, button, isAutoPlay = false) {
        // XHRリクエストを準備
        const currentConfig = GM_getValue(STORE_KEY, config);
        const synthesizeUrl = `${currentConfig.apiUrl}/synthesis?speaker=${currentConfig.speakerId}`;

        // XHRオブジェクトを保存
        const xhr = GM_xmlhttpRequest({
            method: 'POST',
            url: synthesizeUrl,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify(audioQuery),
            responseType: 'blob',
            onload: function(response) {
                currentXhr = null; // リクエスト完了

                if (response.status === 200 && response.response) {
                    const audioBlob = response.response;

                    const audioUrl = URL.createObjectURL(audioBlob);
                    const audio = new Audio(audioUrl);

                    // グローバル変数にAudioオブジェクトを保持
                    currentAudio = audio;
                    isPlaying = true;

                    audio.play();

                    audio.onended = () => {
                        URL.revokeObjectURL(audioUrl);
                        // 再生終了時に状態をリセット
                        resetOperation(button);
                    };

                    // 再生が始まったらボタンを停止表示に変更
                    if(button) {
                        button.textContent = '■ 停止';
                        button.style.backgroundColor = '#dc3545';
                        button.removeEventListener('click', startConversion);
                        button.addEventListener('click', stopConversion);
                    }

                    showToast('WAVデータの取得に成功したわ！音声再生中よ！', true);
                } else {
                    showToast(`VOICEVOX合成に失敗したわ... (Status: ${response.status})`, false);
                    console.error('VOICEVOX Synthesize Error:', response);
                    resetOperation(button); // エラー時もリセット
                }
            },
            onerror: function(error) {
                currentXhr = null; // リクエスト完了
                showToast('合成中にエラーが発生したわ。VOICEVOXエンジンは起動している？', false);
                console.error('VOICEVOX Synthesize Connection Error:', error);
                resetOperation(button); // エラー時もリセット
            }
        });
        currentXhr = xhr; // XHRオブジェクトを保存
    }

    function synthesizeSampleAudio(audioQuery, button, text, speakerId) {
        showToast(`テストテキスト合成中...`, null);

        const currentConfig = GM_getValue(STORE_KEY, config);
        const synthesizeUrl = `${currentConfig.apiUrl}/synthesis?speaker=${speakerId}`;

        // 再生停止ボタンに切り替え
        if (button) {
            button.textContent = '■ 再生停止';
            button.style.backgroundColor = '#dc3545'; // Red
            button.removeEventListener('click', startSampleConversion);
            button.addEventListener('click', stopConversion); // グローバル停止関数を呼ぶ
        }

        const xhr = GM_xmlhttpRequest({
            method: 'POST',
            url: synthesizeUrl,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify(audioQuery),
            responseType: 'blob',
            onload: function(response) {
                currentXhr = null; // リクエスト完了
                if (response.status === 200 && response.response) {
                    const audioBlob = response.response;
                    const audioUrl = URL.createObjectURL(audioBlob);
                    const audio = new Audio(audioUrl);
                    currentAudio = audio;
                    isPlaying = true;
                    audio.play();

                    audio.onended = () => {
                        URL.revokeObjectURL(audioUrl);
                        // 再生終了時に状態をリセット (メインボタンは操作しない)
                        resetOperation(null);
                        resetSampleButtonState(button); // サンプルボタンを再開表示に戻す
                    };
                    showToast('テスト音声再生中よ！', true);
                } else {
                    showToast(`VOICEVOX合成に失敗したわ... (Status: ${response.status})`, false);
                    console.error('VOICEVOX Synthesize Error:', response);
                    resetOperation(null);
                    resetSampleButtonState(button);
                }
            },
            onerror: function(error) {
                currentXhr = null;
                showToast('テスト音声の合成中にエラーが発生したわ。', false);
                console.error('VOICEVOX Synthesize Connection Error:', error);
                resetOperation(null);
                resetSampleButtonState(button);
            }
        });
        currentXhr = xhr;
    }

    function startSampleConversion() {
        const SAMPLE_TEXT = '音声のテストだよ！この声で読み上げするよ！';
        const button = document.getElementById('mei-sample-play-btn');
        const speakerIdInput = document.getElementById('speakerId');

        if (isPlaying || currentXhr) {
            showToast('今は再生中か合成中よ。停止ボタンで止めてね。', false);
            return;
        }

        // 入力値を取得し、不正な値ならエラー
        if (!speakerIdInput) return; // 念の為のガード
        const currentSpeakerId = parseInt(speakerIdInput.value, 10);

        if (isNaN(currentSpeakerId) || currentSpeakerId < 0) {
            showToast('スピーカーIDが不正よ！半角数字を確認してね。', false);
            return;
        }

        // 合成中の状態
        if (button) {
            button.textContent = '⏱ 合成中...';
            button.style.backgroundColor = '#6c757d';
            button.removeEventListener('click', startSampleConversion);
            button.addEventListener('click', stopConversion); // グローバル停止関数を呼ぶ
        }

        const currentConfig = GM_getValue(STORE_KEY, config);
        const audioQueryUrl = `${currentConfig.apiUrl}/audio_query`;
        const queryParams = new URLSearchParams({
            text: SAMPLE_TEXT,
            speaker: currentSpeakerId
        });

        const xhr = GM_xmlhttpRequest({
            method: 'POST',
            url: `${audioQueryUrl}?${queryParams.toString()}`,
            headers: { 'Content-Type': 'application/json' },
            onload: function(response) {
                currentXhr = null; // リクエスト完了
                if (response.status === 200) {
                    const audioQuery = JSON.parse(response.responseText);
                    synthesizeSampleAudio(audioQuery, button, SAMPLE_TEXT, currentSpeakerId);
                } else {
                    showToast(`VOICEVOXとの連携に失敗したわ... (Status: ${response.status})`, false);
                    console.error('VOICEVOX Query Error:', response);
                    resetOperation(null);
                    resetSampleButtonState(button);
                }
            },
            onerror: function(error) {
                currentXhr = null; // リクエスト完了
                showToast('VOICEVOXエンジンに接続できないわ... 起動しているか確認してね。', false);
                console.error('VOICEVOX Connection Error:', error);
                resetOperation(null);
                resetSampleButtonState(button);
            }
        });
        currentXhr = xhr; // XHRオブジェクトを保存
    }

    function resetSampleButtonState(button) {
        if (button) {
            button.textContent = '🔊 サンプル再生';
            button.style.backgroundColor = '#5cb85c'; // Green
            button.removeEventListener('click', stopConversion);
            button.addEventListener('click', startSampleConversion);
            button.disabled = false;
        }
    }

    async function startConversion(isAutoPlay = false) {
        const button = document.getElementById('convertButton');

        // 1. 再生中チェック
        if (isPlaying) {
            if (isAutoPlay) {
                // 自動再生時は再生中の音声を強制停止して、新しい合成を優先
                // console.log('[ABORT_PLAYING] 新しい自動再生が検出されたため、再生中の音声を強制停止するわ！');
                resetOperation(button); // Audio停止と状態リセットを実行
            } else {
                // 手動再生中に別の手動操作が来た場合はブロック
                showToast('今は再生中よ。停止ボタンで止めてから次の操作をしてね。', false);
                return;
            }
        }

        // 2. 合成中チェック（自動再生時は中断して優先、手動時はブロック）
        if (currentXhr) {
            if (isAutoPlay) {
                // 新しい自動再生が来たら、前の合成処理をキャンセルして、新しい合成を優先する
                // console.log('[ABORT] 新しい自動再生が検出されたため、前の合成処理をキャンセルします。');
                resetOperation(button);
            } else {
                // 手動合成中に別の手動合成が来た場合はブロック
                showToast('今は合成中よ。停止ボタンで止めてから次の操作をしてね。', false);
                return;
            }
        }

        if (isAutoPlay) {
            // 自動再生の場合はトーストを控えめに
        } else {
            showToast('Geminiの回答を取得中...', null);
        }

        const text = getGeminiAnswerText();

        if (!text || text.trim() === '') {
            showToast('回答テキストが取得できなかったか、全て除去されたわ...', false);
            return;
        }

        if (!isAutoPlay) {
            showToast(`テキストクレンジング完了！送信テキスト: "${text.substring(0, 30)}..."`, null);
        } else {
            // 自動再生の場合はテキスト表示も省略
        }

        // 合成中のボタン表示に変更
        if (button) {
            button.textContent = '⏱ 合成中...';
            button.style.backgroundColor = '#6c757d';
            button.removeEventListener('click', startConversion);
            button.addEventListener('click', stopConversion);
        }
        showToast('音声データを合成準備中...', null);

        const currentConfig = GM_getValue(STORE_KEY, config);
        const audioQueryUrl = `${currentConfig.apiUrl}/audio_query`;
        const queryParams = new URLSearchParams({
            text: text,
            speaker: currentConfig.speakerId
        });

        // XHRオブジェクトを保存
        const xhr = GM_xmlhttpRequest({
            method: 'POST',
            url: `${audioQueryUrl}?${queryParams.toString()}`,
            headers: { 'Content-Type': 'application/json' },
            onload: function(response) {
                currentXhr = null; // リクエスト完了

                if (response.status === 200) {
                    const audioQuery = JSON.parse(response.responseText);
                    synthesizeAudio(audioQuery, button, isAutoPlay);
                } else {
                    showToast(`VOICEVOXとの連携に失敗したわ... (Status: ${response.status})`, false);
                    console.error('VOICEVOX Query Error:', response);
                    resetOperation(button); // エラー時もリセット
                }
            },
            onerror: function(error) {
                currentXhr = null; // リクエスト完了
                showToast('VOICEVOXエンジンに接続できないわ... 起動しているか確認してね。', false);
                console.error('VOICEVOX Connection Error:', error);
                resetOperation(button);
            }
        });
        currentXhr = xhr; // XHRオブジェクトを保存
        if (isAutoPlay) {
            lastAutoPlayedText = text; // 自動再生の場合、本文をキャッシュする
        }
    }

    // ========= 設定UI表示関数 =========
    function openSettings() {
        if (document.getElementById('mei-settings-overlay')) {
            return;
        }

        config = GM_getValue(STORE_KEY, config);

        // 1. OVERLAY (トップコンテナ)
        const overlay = document.createElement('div');
        overlay.id = 'mei-settings-overlay';
        overlay.style.cssText = 'display: flex; justify-content: center; align-items: center;';
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
                document.removeEventListener('keydown', escListener); // ESCリスナーも削除
            }
        });

        // ESCキーで閉じる
        const escListener = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                overlay.remove();
                document.removeEventListener('keydown', escListener);
            }
        };
        document.addEventListener('keydown', escListener);

        // 2. PANEL (設定パネル本体)
        const panel = document.createElement('div');
        panel.id = 'mei-settings-panel';

        // 3. TITLE (タイトル)
        const titleH2 = document.createElement('h2');
        titleH2.textContent = `🔊 VOICEVOX連携 設定 (V${SCRIPT_VERSION})`;
        titleH2.style.cssText = 'margin-top: 0; margin-bottom: 20px; font-size: 1.5em; color: #e8eaed;';
        panel.appendChild(titleH2);
        panel.addEventListener('click', (e) => {
            // パネル内でのクリックイベントの伝播をここで完全に停止させる
            e.stopPropagation();
        });

        // 4. SPEAKER ID GROUP
        const speakerGroup = document.createElement('div');
        speakerGroup.style.cssText = 'display: flex; align-items: center; margin-bottom: 5px;';

        const speakerLabel = document.createElement('label');
        speakerLabel.textContent = 'VOICEVOX スピーカーID:';
        speakerLabel.setAttribute('for', 'speakerId');
        speakerLabel.style.cssText = 'font-weight: bold; color: #9aa0a6; margin-right: 15px; flex-shrink: 0;';
        speakerGroup.appendChild(speakerLabel);

        const speakerInput = document.createElement('input');
        speakerInput.type = 'number';
        speakerInput.id = 'speakerId';
        speakerInput.value = config.speakerId;
        speakerInput.min = '0';
        speakerInput.step = '1';
        speakerInput.style.cssText = 'width: 80px; flex-grow: 0;';
        speakerInput.classList.add('mei-input-field');
        speakerGroup.appendChild(speakerInput);

        // 話者名表示エリアを追加
        const speakerNameDisplay = document.createElement('span');
        speakerNameDisplay.id = 'speakerNameDisplay';
        speakerNameDisplay.textContent = '（確認中...）';
        speakerNameDisplay.style.cssText = 'margin-left: 10px; font-weight: bold; color: #4CAF50;'; // Green for cool success
        speakerGroup.appendChild(speakerNameDisplay);
        panel.appendChild(speakerGroup);

        // ヘルプテキストを追加のdivで分離し、1行表示を維持
        const speakerHelpGroup = document.createElement('div');
        speakerHelpGroup.style.marginBottom = '15px';
        const speakerHelp = document.createElement('p');
        speakerHelp.textContent = '*使用する声のIDを半角数字で入力してね。';
        speakerHelp.style.cssText = 'margin-top: 5px; font-size: 0.8em; color: #9aa0a6;';
        speakerHelpGroup.appendChild(speakerHelp);
        panel.appendChild(speakerHelpGroup);

        function updateSpeakerNameDisplay(id) {
            const apiUrl = config.apiUrl;
            const display = document.getElementById('speakerNameDisplay');
            if (!display) return;

            display.textContent = '（確認中...）';
            display.style.color = '#5bc0de'; // Info Blue

            // 進行中のリクエストがあればキャンセル
            if (currentSpeakerNameXhr) {
                currentSpeakerNameXhr.abort();
                currentSpeakerNameXhr = null;
            }

            // APIリクエスト
            currentSpeakerNameXhr = GM_xmlhttpRequest({
                method: 'GET',
                url: `${apiUrl}/speakers`,
                onload: function(response) {
                    currentSpeakerNameXhr = null;
                    console.log(`[VOICEVOX_NAME] /speakers 応答 Status: ${response.status}`); 
                    
                    if (response.status === 200) {
                        try {
                            const speakers = JSON.parse(response.responseText);
                            
                            // 🌟 V4.5 FIX: 話者リスト全体をログにダンプ 🌟
                            console.groupCollapsed(`[VOICEVOX_NAME] 検出された話者リスト（全 ${speakers.length} 件）`);
                            console.log(speakers); // 全話者の詳細を表示
                            console.groupEnd();
                            
                            const targetId = parseInt(id, 10);
                            console.log(`[VOICEVOX_NAME] 検索中のID: ${targetId}`); // 検索対象IDを表示
                            
                            let speakerName = '不明なID';
                            let styleName = '';

                            // IDから話者とスタイルを探索
                            for (const speaker of speakers) {
                                for (const style of speaker.styles) {
                                    // スタイルIDが一致するかチェック
                                    if (style.id === targetId) { // targetId（数値）と比較
                                        speakerName = speaker.name;
                                        styleName = style.name;
                                        break;
                                    }
                                }
                                if (styleName) break;
                            }
                            
                            if (styleName) {
                                display.textContent = `${speakerName}（${styleName}）`;
                                display.style.color = '#4CAF50'; 
                                console.log(`[VOICEVOX_NAME] ID ${targetId} は ${speakerName}（${styleName}）よ！`);
                            } else {
                                // 200だがIDが見つからない
                                display.textContent = '（IDが見つからないわ...）';
                                display.style.color = '#d9534f'; 
                                console.warn(`[VOICEVOX_NAME] 設定されたID ${targetId} はリストに見つからなかったわ...`);
                            }

                        } catch (e) {
                            display.textContent = '（JSONパースエラーよ...）';
                            display.style.color = '#d9534f'; 
                            console.error('[VOICEVOX_NAME] JSONパースエラー:', e);
                        }
                    } else {
                        // 200以外のステータス
                        display.textContent = `（APIエラー: ${response.status}）`;
                        display.style.color = '#d9534f'; 
                    }
                },
                onerror: function(error) {
                    currentSpeakerNameXhr = null;
                    display.textContent = '（接続エラーよ...）';
                    display.style.color = '#d9534f'; 
                    // 🌟 V4.5 FIX: 接続エラーをログ出力 🌟
                    console.error('[VOICEVOX_NAME] 接続エラー！', error);
                }
            });
        }

        // 🌟 入力値が変わったら更新 🌟
        speakerInput.addEventListener('input', (e) => {
             updateSpeakerNameDisplay(e.target.value);
        });

        // サンプル再生ボタン
        const sampleGroup = document.createElement('div');
        sampleGroup.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-top: 5px; border-top: 1px solid #444;';

        const sampleText = document.createElement('p');
        sampleText.textContent = '👆この声で合っているかテストよ！';
        sampleText.style.cssText = 'margin: 0; font-size: 0.9em; color: #e8eaed;';
        sampleGroup.appendChild(sampleText);

        const sampleBtn = document.createElement('button');
        sampleBtn.id = 'mei-sample-play-btn';
        sampleBtn.textContent = '🔊 サンプル再生';
        sampleBtn.classList.add('mei-button-primary');
        sampleBtn.style.backgroundColor = '#5cb85c'; // Green color for sample
        sampleBtn.style.color = 'white';
        sampleBtn.style.fontWeight = 'bold';
        sampleBtn.addEventListener('click', startSampleConversion);
        sampleGroup.appendChild(sampleBtn);
        panel.appendChild(sampleGroup);

        // 5. API URL GROUP
        const apiGroup = document.createElement('div');
        apiGroup.style.cssText = 'display: flex; align-items: center; margin-bottom: 20px;';

        const apiLabel = document.createElement('label');
        apiLabel.textContent = 'VOICEVOX API URL:';
        apiLabel.setAttribute('for', 'apiUrl');
        apiLabel.style.cssText = 'font-weight: bold; color: #9aa0a6; margin-right: 15px; flex-shrink: 0;';
        apiGroup.appendChild(apiLabel);

        const apiInput = document.createElement('input');
        apiInput.type = 'url';
        apiInput.id = 'apiUrl';
        apiInput.value = config.apiUrl;
        apiInput.style.cssText = 'flex-grow: 1;';
        apiInput.classList.add('mei-input-field');
        apiGroup.appendChild(apiInput);
        panel.appendChild(apiGroup);

        // 自動再生 ON/OFF トグル
        const autoPlayGroup = document.createElement('div');
        autoPlayGroup.style.cssText = 'display: flex; align-items: center; margin-bottom: 20px;';

        const autoPlayInput = document.createElement('input');
        autoPlayInput.type = 'checkbox';
        autoPlayInput.id = 'autoPlay';
        autoPlayInput.checked = config.autoPlay;
        autoPlayInput.style.cssText = 'width: 20px; height: 20px; margin-right: 10px; flex-shrink: 0;';
        autoPlayGroup.appendChild(autoPlayInput);

        const autoPlayLabel = document.createElement('label');
        autoPlayLabel.textContent = '自動再生を有効にする (Geminiが回答完了したら自動再生)';
        autoPlayLabel.setAttribute('for', 'autoPlay');
        autoPlayLabel.style.cssText = 'font-weight: bold; color: #e8eaed; cursor: pointer;';
        autoPlayGroup.appendChild(autoPlayLabel);
        panel.appendChild(autoPlayGroup);

        // 最低読み上げ文字数 GROUP (minTextLength)
        const minLengthGroup = document.createElement('div');
        minLengthGroup.style.cssText = 'display: flex; align-items: center; margin-bottom: 5px;';

        const minLengthLabel = document.createElement('label');
        minLengthLabel.textContent = '最低読み上げ文字数 (文字):';
        minLengthLabel.setAttribute('for', 'minTextLength');
        minLengthLabel.style.cssText = 'font-weight: bold; color: #9aa0a6; margin-right: 15px; flex-shrink: 0;';
        minLengthGroup.appendChild(minLengthLabel);

        const minLengthInput = document.createElement('input');
        minLengthInput.type = 'number';
        minLengthInput.id = 'minTextLength';

        // 設定ファイルから値を取得
        minLengthInput.value = config.minTextLength;
        minLengthInput.min = '0';
        minLengthInput.step = '1';
        minLengthInput.classList.add('mei-input-field');
        minLengthInput.style.cssText = 'width: 80px; flex-grow: 0;'; // 幅を固定
        minLengthGroup.appendChild(minLengthInput);
        panel.appendChild(minLengthGroup);

        const minLengthHelp = document.createElement('p');
        minLengthHelp.textContent = '*この文字数以下の短い回答や待機メッセージは自動再生されないわ！';
        minLengthHelp.style.cssText = 'margin-top: 5px; margin-bottom: 20px; font-size: 0.8em; color: #9aa0a6;';
        panel.appendChild(minLengthHelp);

        // キー設定グループ
        const keyGroup = document.createElement('div');
        keyGroup.style.cssText = 'display: flex; align-items: center; margin-bottom: 5px;';

        const keyLabel = document.createElement('label');
        keyLabel.textContent = '再生/停止 ショートカットキー:';
        keyLabel.setAttribute('for', 'shortcutKey');
        keyLabel.style.cssText = 'font-weight: bold; color: #9aa0a6; margin-right: 15px; flex-shrink: 0;';
        keyGroup.appendChild(keyLabel);

        const keyInput = document.createElement('input');
        keyInput.type = 'text';
        keyInput.id = 'shortcutKey';
        keyInput.value = config.shortcutKey;
        keyInput.classList.add('mei-input-field');
        keyInput.style.cssText = 'background-color: #2c2c2c; width: 160px; flex-grow: 0;'; // 幅を固定
        keyInput.readOnly = true;
        keyGroup.appendChild(keyInput);
        panel.appendChild(keyGroup);

        const keyHelp = document.createElement('p');
        keyHelp.textContent = '*クリックしてから「Ctrl+Shift+V」などのキーをクールに押して設定してね！';
        keyHelp.style.cssText = 'margin-top: 5px; margin-bottom: 20px; font-size: 0.8em; color: #9aa0a6;';
        panel.appendChild(keyHelp);

        // キー録音ロジック
        let isRecording = false;

        keyInput.addEventListener('click', () => {
            if (isRecording) {
                isRecording = false;
                keyInput.style.backgroundColor = '#2c2c2c';
                if (keyInput.value.includes('...')) {
                    keyInput.value = config.shortcutKey; // 途中でやめたら元の値に戻す
                }
                return;
            }

            isRecording = true;
            keyInput.value = 'キーを押してください...';
            keyInput.style.backgroundColor = '#4d4d4d';
        });

        const recordKey = (e) => {
            if (!isRecording) return;
            e.preventDefault();
            e.stopPropagation();

            const isControl = e.ctrlKey || e.metaKey; // CommandキーもControlとして扱う
            const isAlt = e.altKey;
            const isShift = e.shiftKey;

            // ファンクションキー, Alt, Ctrl, Shift単体は許可しない
            if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key.startsWith('F')) {
                keyInput.value = '単体キーはダメよ！組み合わせてね。';
                return;
            }

            // IME入力中は処理しない
            if (e.isComposing || e.keyCode === 229) return;

            // Keyを大文字化
            let key = e.key;
            if (key.length === 1) {
                key = key.toUpperCase();
            } else if (key === ' ') {
                key = 'Space';
            }

            let shortcut = '';

            // V3.6 修正: 'Control' ではなく 'Ctrl' を使用
            if (isControl) shortcut += 'Ctrl+';
            if (isAlt) shortcut += 'Alt+';
            if (isShift) shortcut += 'Shift+';

            // 組み合わせがない場合は、エラーを出す
            if (!isControl && !isAlt && !isShift) {
                keyInput.value = 'Ctrl, Alt, Shiftのどれかは必須よ！';
                return;
            }

            if (key !== 'Control' && key !== 'Shift' && key !== 'Alt' && key !== 'Meta') {
                shortcut += key;
            }

            if (shortcut.endsWith('+') || shortcut === '' || shortcut === 'Ctrl+' || shortcut === 'Alt+' || shortcut === 'Shift+') {
                keyInput.value = '有効なキーの組み合わせじゃないわ...';
                return;
            }

            // 成功
            keyInput.value = shortcut;
            keyInput.style.backgroundColor = '#2c2c2c';
            isRecording = false;
        };

        keyInput.addEventListener('keydown', recordKey);
        panel.addEventListener('keydown', (e) => {
            // Spaceキーが押された場合にスクロールを防ぐ
            if (e.key === ' ' && isRecording) e.preventDefault();
        });

        // 6. BUTTON GROUP
        const buttonGroup = document.createElement('div');
        buttonGroup.style.cssText = 'display: flex; justify-content: flex-end; gap: 10px;';

        const closeBtn = document.createElement('button');
        closeBtn.id = 'mei-close';
        closeBtn.textContent = 'キャンセル';
        closeBtn.classList.add('mei-button-secondary');
        buttonGroup.appendChild(closeBtn);

        const saveBtn = document.createElement('button');
        saveBtn.id = 'mei-save';
        saveBtn.textContent = '保存';
        saveBtn.classList.add('mei-button-primary');
        buttonGroup.appendChild(saveBtn);
        panel.appendChild(buttonGroup);

        // 7. DOMにパネルとオーバーレイを追加
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        // 8. イベントリスナーの設定
        closeBtn.addEventListener('click', () => {
            document.removeEventListener('keydown', escListener);
            overlay.remove();
        });

        // 🌟 初期表示時に実行 🌟
        updateSpeakerNameDisplay(config.speakerId);

        saveBtn.addEventListener('click', () => {
            const newSpeakerId = parseInt(speakerInput.value, 10);
            const newApiUrl = apiInput.value.trim();
            const newAutoPlay = autoPlayInput.checked;
            const newShortcutKey = keyInput.value.trim();
            const minTextLengthInput = document.getElementById('minTextLength');
            const newMinTextLength = parseInt(minTextLengthInput.value, 10);

            if (isNaN(newSpeakerId) || newSpeakerId < 0) {
                showToast('スピーカーIDは半角数字で、0以上の値を入力してね！', false);
                return;
            }

            if (newShortcutKey === 'キーを押してください...' || newShortcutKey.includes('は必須よ！') || newShortcutKey.includes('じゃないわ...')) {
                showToast('ショートカットキーを正しく設定してね！', false);
                return;
            }

            if (isNaN(newMinTextLength) || newMinTextLength < 0) {
                showToast('最低読み上げ文字数は半角数字で、0以上の値を入力してね！', false);
                return;
            }

            const newConfig = {
                speakerId: newSpeakerId,
                apiUrl: newApiUrl,
                autoPlay: newAutoPlay,
                minTextLength: newMinTextLength,
                shortcutKey: newShortcutKey
            };

            GM_setValue(STORE_KEY, newConfig);
            config = newConfig;
            showToast('設定をクールに保存したわ！', true);
            document.removeEventListener('keydown', escListener);
            overlay.remove();
        });
    }

    // グローバルキーイベントリスナー
    function handleGlobalKeyDown(e) {
        // IME入力中は処理しない
        if (e.isComposing || e.keyCode === 229) return;

        // 設定が読み込まれていない、または設定が無効な場合は何もしない
        if (!config || !config.shortcutKey) return;

        const isControl = e.ctrlKey || e.metaKey; // CtrlまたはCommand
        const isAlt = e.altKey;
        const isShift = e.shiftKey;
        const button = document.getElementById('convertButton');

        // ボタンが存在しないか、設定パネルが開いている場合は何もしない
        if (!button || document.getElementById('mei-settings-overlay')) return;

        // Keyを大文字化
        let key = e.key;
        if (key.length === 1) {
            key = key.toUpperCase();
        } else if (key === ' ') {
            key = 'Space';
        }

        let pressedShortcut = '';

        if (isControl) pressedShortcut += 'Ctrl+'; // 'Ctrl' に統一
        if (isAlt) pressedShortcut += 'Alt+';
        if (isShift) pressedShortcut += 'Shift+';

        // 最後のキーが修飾キーではないことを確認 (Control, Shift, Alt, Meta)
        if (key !== 'Control' && key !== 'Shift' && key !== 'Alt' && key !== 'Meta') {
            pressedShortcut += key;
        }

        // キーが一致したら実行
        if (pressedShortcut === config.shortcutKey) {
            e.preventDefault(); // デフォルトの動作を抑制 (ブラウザショートカットなど)
            e.stopPropagation();

            // 再生中または合成中なら停止、それ以外なら再生
            if (isPlaying || currentXhr) {
                stopConversion();
            } else {
                // 再生開始。手動操作なので isAutoPlay は false
                startConversion(false);
            }
        }
    }

    // MutationObserverのロジック
    function observeDOMChanges() {
        // 監視ノードをdocument.bodyに固定
        const TARGET_NODE = document.body;
        const observer = new MutationObserver(function(mutations, observer) {
            // DOM操作が落ち着くまで待つ (デバウンス)
            clearTimeout(debounceTimerId);

            debounceTimerId = setTimeout(function() {
                addConvertButton();

                // 自動再生ロジック
                const currentConfig = GM_getValue(STORE_KEY, config);
                const button = document.getElementById('convertButton');

                // 自動再生がONで、ボタンが存在し、再生/合成中でなく、まだ自動再生されていない場合
                // 🌟 currentXhr のチェックも、新しい startConversion の中で行うため、本来はここでなくても大丈夫だが、安全のため残す 🌟
                if (currentConfig.autoPlay && button) {
                    // 正確な最新回答パネルの特定
                    const allResponseContainers = document.querySelectorAll('.response-container');
                    // コンテナが一つもない場合は処理を終了（安全のために return を使用）
                    if (allResponseContainers.length === 0) return;
                    const answerContainer = allResponseContainers[allResponseContainers.length - 1]; // 最後の回答パネルを取得
                    const hasFooter = answerContainer ? answerContainer.querySelector('.response-container-footer') : null;
                    const minLength = currentConfig.minTextLength || 0;
                    const currentText = getGeminiAnswerText();

                    // フッターがあり＆最低文字数を超えている＆キャッシュと比較して別のものの場合に自動再生
                    if (currentText.length > minLength && hasFooter && currentText !== lastAutoPlayedText) {
                        startConversion(true); // trueで自動再生として実行
                    }
                }
            }, DEBOUNCE_DELAY);
        });

        const observerConfig = { childList: true, subtree: true };
        observer.observe(TARGET_NODE, observerConfig);

        // 初回実行
        addConvertButton();
    }

    // メニュー登録
    if (settingsMenuId) GM_unregisterMenuCommand(settingsMenuId);
    settingsMenuId = GM_registerMenuCommand('🔊 設定', openSettings);

    // DOM監視を開始
    // window.onloadを待つと設定UIが登録されない場合があるため、即時実行に戻す
    observeDOMChanges();
    // グローバルキーイベントリスナー
    document.addEventListener('keydown', handleGlobalKeyDown);

})();
