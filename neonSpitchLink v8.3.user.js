// ==UserScript==
// @name           ねおん すぴっち リンク
// @name:ja        ねおん すぴっち リンク
// @name:en        Neon Spitch Link
// @namespace      https://bsky.app/profile/neon-ai.art
// @homepage       https://neon-aiart.github.io/
// @icon           data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>💬</text></svg>
// @version        8.3
// @description    Gemini/ChatGPTのお返事を、VOICEVOX＆RVCと連携して自動読み上げ！
// @description:ja Gemini/ChatGPTのお返事を、VOICEVOX＆RVCと連携して自動読み上げ！
// @description:en Seamlessly connect Gemini/ChatGPT responses to VOICEVOX & RVC for automatic speech synthesis.
// @author         ねおん
// @match          https://gemini.google.com/*
// @match          https://chatgpt.com/*
// @include        https://www.google.*/search*
// @include        https://x.com/*
// @include        https://grok.com/*
// @grant          GM_xmlhttpRequest
// @grant          GM_addStyle
// @grant          GM_getValue
// @grant          GM_setValue
// @grant          GM_deleteValue
// @grant          GM_registerMenuCommand
// @grant          GM_unregisterMenuCommand
// @connect        localhost
// @license        PolyForm Noncommercial 1.0.0; https://polyformproject.org/licenses/noncommercial/1.0.0/
// @downloadURL    https://update.greasyfork.org/scripts/552996/%E3%81%AD%E3%81%8A%E3%82%93%20%E3%81%99%E3%81%B4%E3%81%A3%E3%81%A1%20%E3%83%AA%E3%83%B3%E3%82%AF.user.js
// @updateURL      https://update.greasyfork.org/scripts/552996/%E3%81%AD%E3%81%8A%E3%82%93%20%E3%81%99%E3%81%B4%E3%81%A3%E3%81%A1%20%E3%83%AA%E3%83%B3%E3%82%AF.meta.js
// ==/UserScript==

/**
 * ==============================================================================
 * IMPORTANT NOTICE / 重要事項
 * ==============================================================================
 * Copyright (c) 2025 ねおん (Neon)
 * Licensed under the PolyForm Noncommercial License 1.0.0.
 * * [JP] 本スクリプトは個人利用・非営利目的でのみ使用・改変が許可されます。
 * 無断転載、作者名の書き換え、およびクレジットの削除は固く禁じます。
 * 本スクリプトを改変・配布（フォーク）する場合は、必ず元の作者名（ねおん）
 * およびこのクレジット表記を維持してください。
 * * [EN] This script is licensed for personal and non-commercial use only.
 * Unauthorized re-uploading, modification of authorship, or removal of
 * author credits is strictly prohibited. If you fork this project, you MUST
 * retain the original credits and authorship.
 * ==============================================================================
 */

(function() {
    'use strict';

    const SCRIPT_VERSION = '8.3';
    const STORE_KEY = 'gemini_voicevox_config';

    // ========= グローバルな再生・操作制御変数 =========
    let currentAudio = null;
    let currentXhrs = [];               // 合成中のXHRを配列として定義（中断用）
    let isConversionStarting = false;   // 合成処理全体が開始したことを示すフラグ
    let isConversionAborted = false;    // 合成の中断要求があったかを示すフラグ
    let currentSpeakerNameXhr = null;   // スピーカー名取得用のXHR
    let isPlaying = false;
    let isPause = false;
    let lastAutoPlayedText = '';        // 最後に自動再生したテキストをキャッシュ
    const MAX_RETRY_COUNT = 3;          // 最大リトライ回数
    let toastTimeoutId = null;
    let isRvcModelLoading = false;      // RVCモデル情報のロード中フラグ（排他制御用）
    const DEFAULT_CHUNK_SIZE = 100;     // 初期チャンクサイズ
    const VOICEVOX_TIMEOUT_MS = 60000;  // 60秒 VOICEVOX/RVCのXHR通信タイムアウト値（ミリ秒）

    // ========= Web Audio API (ストリーミング再生) 関連 =========
    /** @type {AudioContext | null} Web Audio APIのコンテキスト。音の心臓部よ！*/
    let audioContext = null;
    /** @type {AudioBufferSourceNode | null} 現在再生中の音源ノード。停止に使うわ。*/
    let currentSourceNode = null;
    /** @type {number} 現在再生中のチャンクが終了する予定時刻（AudioContext.currentTimeを基準）。キューイングに使うわ。*/
    let nextStartTime = 0;
    /** @type {number} 全体のチャンク数。再生完了の判定に使うわ。*/
    let totalStreamingChunks = 0;
    /** @type {number} 現在再生が完了したチャンクの数。*/
    let finishedStreamingChunks = 0;
    /** @type {string | null} ストリーミング再生で使うためのキャッシュキー */
    let currentStreamingCacheKey = null;

    // ========= グローバルなキャッシュキー =========
    const LAST_CACHE_HASH = 'latest_audio_cache_hash'; // テキストと設定のハッシュを保存
    const LAST_CACHE_DATA = 'latest_audio_cache_data'; // Base64 WAVデータを保存

    // クエリ検索（コンテナ・フッター）
    const SELECTORS_RESPONSE = [ {
        // Gemini
        container: 'response-container',
        footer: '.more-menu-button-container',
    }, {
        // ChatGPT
        container: 'article[data-turn="assistant"]',
        footer: 'button',
    }, {
        // Google AIモード
        container: 'div[data-container-id="main-col"]',
        footer: 'button',
    }, {
        // Grok
        container: 'div[id^="response-"].items-start',
        footer: '.group-focus-within\\:opacity-100',
    }, {
        // x.com/i/grok*
        container: 'div.r-16lk18l.r-13qz1uu',
        footer: 'div.r-18u37iz.r-1jnkns4',
    }, {
        // x.com/i/grok* （予備）
        container: 'div:has(div > div > div > div > div > button > div > svg path[d^="M21.869 16h-3.5c-.77"])',
        footer: 'button:has(svg path[d^="M21.869 16h-3.5c-.77"])',
    }, ];

    // URL制御用セクレタ配列（shouldExecuteで使用）
    const WHITELIST_PATHS = [
        '/app*', '/gem*', '/u/*/app*', '/u/*/gem*', '/c', '/c/*', '/g/*', '/search?*udm=50*', '/i/grok*',
    ];
    const BLACKLIST_PATHS = [
        '/saved-info', '/apps', '/sharing', '/gems/*', '/settings',
        '/u/*/saved-info', '/u/*/apps', '/u/*/sharing', '/u/*/gems/*', '/u/*/settings',
        '/faq', '/privacy', '/terms',
    ];

    // DOM除去用セクレタ配列（getGeminiAnswerTextで使用）
    const SELECTORS_TO_REMOVE = [
        '#convertButtonWrapper',
        '.extension-processing-state',
        '.attachment-container',
        '.hide-from-message-actions',
        '.cdk-visually-hidden',
        '.gpi-static-text-loader',
        '.avatar-gutter',
        '.legacy-sources-sidebar-button',
        '.thoughts-header',
        '.bot-name', '.sr-only',
        '.tool-summary',
        'pre', 'code-block', 'mat-paginator', 'immersive-entry-chip', 'inline-location', 'user-notice',
        'model-thoughts', 'deletion-candidate-memories-response-block',
        'div[style*="display: none"]', 'div[role="status"]', 'span.cgpt-timestamp',
        'div[role="link"]', 'button', '.action-buttons', '.text-secondary',
        'div[jscontroller="a5f0he"]', // Google検索AIモードのボタン群 '役になった/役に立たない'
    ];

    // 処理中断用セクレタ配列（getGeminiAnswerTextで使用）
    const SELECTORS_TO_INTERRUPT = [
        '.processing-state',      // 応答生成中（例：「思考中」）
        '.stopped-draft-message', // 応答生成が停止された場合
    ];

    // テキスト内容で除去する定型文/NGワードの配列（getGeminiAnswerTextで使用）
    // これらの文字列は、抽出されたテキスト全体から除去されるわ
    // 除去したい単語や定型文を文字列で追加してね。正規表現として解釈されるわ！
    const TEXTS_TO_REMOVE_REGEX = [
        // 日本語版（アプリ アクティビティ）
        "なお、各種アプリのすべての機能を使用するには、Gemini アプリ アクティビティを有効にする必要があります[。\\.]?\\s*",
        // 英語版（Apps Activity notification）
        "Note:\\s?To use all features of the apps?,\\s?you need to enable the Gemini Apps Activity[\\s\\.\\:]?",

        "^[\\s\\S]*?(?=今週の すぴっちリンク ニュース)|(?<=お送りしました。)(?![\\s\\S]*お送りしました。)[\\s\\S]*$",

        /* 💡 NGワード機能として使う例: "今日は", // 「おはよう、今日は晴れです」 -> 「おはよう、晴れです」
         *** 正規表現 ***
         ** 1. 最初の「それでは」より前、ワードを対象に含めない, 対象に含める
         *   > "^[\\s\\S]*?(?=それでは)", "^[\\s\\S]*?それでは",
         ** 2. 最後の「ここまで」より前、ワードを対象に含めない, 対象に含める
         *   > "^[\\s\\S]*(?=ここまで)", "^[\\s\\S]*ここまで",
         ** 3. 最初の「おつかれ」から最後まで、ワードを対象に含めない, 対象に含める
         *   > "(?<=おつかれ)[\\s\\S]*$", "おつかれ[\\s\\S]*$",
         ** 4. 最後の「つづくよ」から最後まで、ワードを対象に含めない, 対象に含める
         *   > "(?<=つづくよ)(?![\\s\\S]*つづくよ)[\\s\\S]*$", "つづくよ(?![\\s\\S]*つづくよ)[\\s\\S]*$",
         ** 5. 最初の「ここから」より前と最後の「そこまで」から最後まで、ワードを対象に含めない, 対象に含める
         *   > "^[\\s\\S]*?(?=ここから)|(?<=そこまで)(?![\\s\\S]*そこまで)[\\s\\S]*$",
         *   > "^[\\s\\S]*?ここから|そこまで(?![\\s\\S]*そこまで)[\\s\\S]*$",
         ***/
    ];

    // ========= 永続化された設定値の読み込み =========
    const DEFAULT_CONFIG = {
        speakerId: 4,
        apiUrl: 'http://localhost:50021',
        autoPlay: true,
        minTextLength: 10,                   // 最小テキスト長 (0～10,000) [10]
        maxChunks: 100,                      // 最大チャンク数 (1～1,000) [100]
        shortcutKey: 'Ctrl+Shift+B',
        dlBtnEnabled: true,                  // ダウンロードボタン
        rvcEnabled: false,                   // RVC 連携スイッチ
        rvcApiUrl: 'http://localhost:7897/', // RVC API URL
        rvcModel: 'rvcModel.pth',            // RVC モデルファイル名
        rvcIndex: '',                        // RVC インデックスファイル名
        rvcPitch: 0,                         // RVC ピッチ (-12～12)
        rvcRatio: 0.75,                      // RVC 検索特徴率
        rvcAlgorithm: 'rmvpe',               // RVC ピッチ抽出アルゴリズム (pm|harvest|crepe|rmvpe)
        rvcResample: 48000,                  // リサンプリング (0～48000) [48000]
        /* ここから設定UIに入ってない初期値をそのまま使う項目 */
        speedScale: 1.0,                     // 速度 (0.0～)
        pitchScale: 0.0,                     // ピッチ (-0.15～0.15)
        intonationScale: 1.0,                // 抑揚 (0.0～)
        volumeScale: 1.0,                    // 音量 (0.0～)
        rvcNumber: 0,                        // 話者ID (0～112)
        rvcEnvelope: 0.25,                   // 入力ソースと出力の音量エンベロープの融合率 (0～1)
        rvcArtefact: 0.33,                   // 明確な子音と呼吸音を保護 (0～0.5)
        rvcMedianFilter: 3,                  // ミュートを減衰させるためのメディアンフィルタ (0～7)
    };
    let savedConfig = GM_getValue(STORE_KEY, DEFAULT_CONFIG);
    let config = {
        ...DEFAULT_CONFIG,
        ...savedConfig,
    };
    GM_setValue(STORE_KEY, config);

    let debounceTimerId = null;
    const DEBOUNCE_DELAY = 200;    // Gemini/ChatGPTは1000で安定 (ミリ秒)
    const DEBUG = true;            // デバッグログ出力フラグ (開発用)
    const DEBUG_BUTTON = false;    // ボタン更新のデバッグログ出力フラグ (開発用)
    const DEBUG_TEXT = false;      // NGワード除去前後のデバッグログ出力フラグ (開発用)
    const DEBUG_DETECTION = false; // DOM検出のデバッグログ出力フラグ (開発用)

    let settingsMenuId = null;
    let rvcSettingsMenuId = null;
    let DownloadMenuId = null;

    // スタイル定義（GM_addStyle）
    GM_addStyle(`
        /* Font Awesome 6 Free */
        @import url('https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css');
        /* Google Material Symbols & Icons (Rounded) */
        @import url('https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200');

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
        /* Chrome, Safari, Edge 用 */
        .mei-input-field::-webkit-outer-spin-button,
        .mei-input-field::-webkit-inner-spin-button {
            margin-left: 4px; /* ここで数字との距離を調整できるわよ！ */
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
        .material-symbols-rounded {
            font-size: 22px;
            line-height: 1;          /* アイコンの上下余白を減らし、中央揃えを改善します */
        }
        #convertButtonWrapper {
            display: flex;           /* Flexboxコンテナにする */
            align-self: center;      /* 親のFlexコンテナ内で自身を中央に配置 */
            height: 28px;
            align-items: center;     /* 垂直方向 */
            justify-content: center; /* 水平方向 */
        }
        #convertButtonIcon {
            font-size: 18px;
            margin-right: 6px;
        }
        #convertButton {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 2px 4px;
            border: none;
            border-radius: 16px;
            color: white;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
            width: auto;
            min-width: 108px;
            height: 100%;
            transition: transform 0.2s, background-color 0.2s;
        }
        #downloadButton {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 2px 4px;
            border: none;
            border-radius: 50%;
            color: white;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
            margin-left: 8px;
            width: 28px;
            height: 100%;
            transition: transform 0.2s, background-color 0.2s;
        }
        #convertButton:hover, #downloadButton:not([disabled]):hover {
            transform: scale(1.05);
        }
        #downloadButton[disabled] {
            background-color: #6c757d !important; /* disabled:bg-gray-500 の代替 */
            color: #bdbdbd !important;            /* disabled:text-gray-300 の代替 */
            cursor: not-allowed !important;       /* disabled:cursor-not-allowed の代替 */
            transform: scale(1.0);                /* 無効時はアニメーションしない */
        }
    `);

    // ========= トーストメッセージ =========
    function showToast(msg, isSuccess) {
        const toastId = 'spitch-toast';
        console.log(`[TOAST] ${msg}`);

        if (toastTimeoutId) {
            clearTimeout(toastTimeoutId);
            toastTimeoutId = null;
        }

        // 20ms遅延させて、重いDOM操作中のレンダリング競合を回避
        setTimeout(() => {
            const existingToast = document.getElementById(toastId);
            if (existingToast) {
                existingToast.remove();
            }

            const toast = document.createElement('div');
            toast.textContent = msg;
            toast.id = toastId;
            toast.classList.add('spitch-toast');

            let bgColor;
            if (isSuccess === true) {
                bgColor = '#007bff';
            } else if (isSuccess === false) {
                bgColor = '#dc3545';
            } else {
                bgColor = '#6c757d';
            }

            toast.style.cssText = `
                position: fixed; bottom: 0px; left: 50%; transform: translateX(-50%);
                background: ${bgColor}; color: white; padding: 4px 20px;
                border-radius: 14px; z-index: 100000;
                height: 24px;
                font-size: 14px; transition: opacity 1.0s ease, transform 1.0s ease; opacity: 0;
            `;
            toast.style.display = 'flex';          // Flexbox有効化
            toast.style.alignItems = 'center';     // 垂直方向の中央揃え
            toast.style.justifyContent = 'center'; // 水平方向の中央揃え
            document.body.appendChild(toast);

            // フェードインアニメーションを起動
            setTimeout(() => {
                toast.style.opacity = '1';
                toast.style.transform = 'translate(-50%, -16px)';
            }, 10);

            // 自動非表示ロジック
            if (isSuccess !== null) {
                toastTimeoutId = setTimeout(() => {
                    toast.style.opacity = '0';
                    toast.style.transform = 'translate(-50%, 0)';
                    setTimeout(() => {
                        if (document.body.contains(toast)) {
                            toast.remove();
                        }
                        if (toastTimeoutId) {
                            toastTimeoutId = null;
                        }
                    }, 1000);
                }, 3000);
            }
        }, 20);
    }

    function getFormattedDateTime() {
        const now = new Date();
        return `${now.getFullYear()}/${(now.getMonth() + 1).toString().padStart(2, '0')}/${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    }

    // ========= VOICEVOX連携 設定UI =========
    function openSettings() {
        if (document.getElementById('mei-settings-overlay')) {
            return;
        }

        config = GM_getValue(STORE_KEY, config);

        // OVERLAY（トップコンテナ）
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

        // PANEL（設定パネル本体）
        const panel = document.createElement('div');
        panel.id = 'mei-settings-panel';

        // TITLE（タイトル）
        const titleH2 = document.createElement('h2');
        titleH2.textContent = `🔊 VOICEVOX連携 設定 (v${SCRIPT_VERSION})`;
        titleH2.style.cssText = 'margin-top: 0; margin-bottom: 20px; font-size: 1.5em; color: #e8eaed;';
        panel.appendChild(titleH2);
        panel.addEventListener('click', (e) => {
            // パネル内でのクリックイベントの伝播をここで完全に停止させる
            e.stopPropagation();
        });

        // SPEAKER ID GROUP
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
        speakerInput.style.cssText = 'width: 80px; flex-grow: 0; text-align: right;';
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
            if (!display) {
                return;
            }

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

                            // 話者リスト全体をログにダンプ
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
                                if (styleName) {
                                    break;
                                }
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
                    // 接続エラーをログ出力
                    console.error('[VOICEVOX_NAME] 接続エラー！', error);
                },
            });
        }

        // 入力値が変わったら更新
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
        sampleBtn.style.cssText = 'display: flex; justify-content: center; align-items: center; height: 32px; width: 128px; line-height: 1; color: white; background: #5cb85c; font-weight: bold; border: none; border-radius: 16px; cursor: pointer;';
        sampleBtn.onclick = () => startSampleConversion();
        sampleGroup.appendChild(sampleBtn);
        panel.appendChild(sampleGroup);

        // API URL GROUP
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

        // 最小読み上げ文字数 GROUP（minTextLength）
        const minLengthGroup = document.createElement('div');
        minLengthGroup.style.cssText = 'display: flex; align-items: center; margin-bottom: 5px;';

        const minLengthLabel = document.createElement('label');
        minLengthLabel.textContent = '最小読み上げ文字数 (1～10,000) [10]:';
        minLengthLabel.setAttribute('for', 'minTextLength');
        minLengthLabel.style.cssText = 'font-weight: bold; color: #9aa0a6; margin-right: 15px; flex-shrink: 0;';
        minLengthGroup.appendChild(minLengthLabel);

        const minLengthInput = document.createElement('input');
        minLengthInput.type = 'number';
        minLengthInput.id = 'minTextLength';
        minLengthInput.value = config.minTextLength; // 設定ファイルから値を取得
        minLengthInput.min = '1';
        minLengthInput.max = '10000';
        minLengthInput.step = '1';
        minLengthInput.classList.add('mei-input-field');
        minLengthInput.style.cssText = 'width: 80px; flex-grow: 0; text-align: right;'; // 幅を固定
        minLengthGroup.appendChild(minLengthInput);
        panel.appendChild(minLengthGroup);

        const minLengthHelp = document.createElement('p');
        minLengthHelp.textContent = '*この文字数以下の短い回答や待機メッセージは自動再生されないわ！';
        minLengthHelp.style.cssText = 'margin-top: 5px; margin-bottom: 20px; font-size: 0.8em; color: #9aa0a6;';
        panel.appendChild(minLengthHelp);

        // 最大読み上げ文字数 GROUP（maxTextLength）
        const maxChunksGroup = document.createElement('div');
        maxChunksGroup.style.cssText = 'display: flex; align-items: center; margin-bottom: 5px;';

        const maxChunksLabel = document.createElement('label');
        maxChunksLabel.textContent = '最大分割数 (10～1,000) [100]:';
        maxChunksLabel.setAttribute('for', 'maxChunks');
        maxChunksLabel.style.cssText = 'font-weight: bold; color: #9aa0a6; margin-right: 15px; flex-shrink: 0;';
        maxChunksGroup.appendChild(maxChunksLabel);

        const maxChunksInput = document.createElement('input');
        maxChunksInput.type = 'number';
        maxChunksInput.id = 'maxChunks';
        maxChunksInput.value = config.maxChunks; // 設定ファイルから値を取得
        maxChunksInput.min = '10';
        maxChunksInput.max = '1000';
        maxChunksInput.step = '1';
        maxChunksInput.classList.add('mei-input-field');
        maxChunksInput.style.cssText = 'width: 80px; flex-grow: 0; text-align: right;';
        maxChunksGroup.appendChild(maxChunksInput);
        panel.appendChild(maxChunksGroup);

        const maxChunksHelp = document.createElement('p');
        maxChunksHelp.textContent = `*この分割数を超えた部分はカットされるわ！（１分割は${DEFAULT_CHUNK_SIZE}文字）`;
        maxChunksHelp.style.cssText = 'margin-top: 5px; margin-bottom: 20px; font-size: 0.8em; color: #9aa0a6;';
        panel.appendChild(maxChunksHelp);

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
        keyHelp.textContent = '*クリックしてから「Ctrl+Shift+V」などのキーを押して設定してね！';
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
            if (!isRecording) {
                return;
            }
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
            if (e.isComposing || e.keyCode === 229) {
                return;
            }

            // Keyを大文字化
            let key = e.key;
            if (key.length === 1) {
                key = key.toUpperCase();
            } else if (key === ' ') {
                key = 'Space';
            }

            let shortcut = '';

            if (isControl) {
                shortcut += 'Ctrl+';
            }
            if (isAlt) {
                shortcut += 'Alt+';
            }
            if (isShift) {
                shortcut += 'Shift+';
            }

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
            if (e.key === ' ' && isRecording) {
                e.preventDefault();
            }
        });

        // 最終フッターグループ: RVCボタン + 保存 + 閉じる
        const finalFooter = document.createElement('div');
        finalFooter.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-top: 20px;';

        const rvcSettingsBtn = document.createElement('button');
        rvcSettingsBtn.textContent = '🔊 RVC連携';
        rvcSettingsBtn.classList.add('mei-button', 'mei-button-secondary');
        rvcSettingsBtn.style.cssText = 'flex-grow: 0; flex-shrink: 0; padding: 10px 15px; margin-right: auto;';
        rvcSettingsBtn.addEventListener('click', () => {
            document.removeEventListener('keydown', escListener); // ESCリスナーを削除
            overlay.remove();  // VOICEVOX設定のオーバーレイを削除
            openRvcSettings(); // RVC設定を開く
        });

        // --- 右側の「保存」と「閉じる」をまとめるグループ ---
        const saveCloseGroup = document.createElement('div');
        saveCloseGroup.style.cssText = 'display: flex; gap: 10px;';

        const saveBtn = document.createElement('button');
        saveBtn.textContent = '保存';
        saveBtn.classList.add('mei-button', 'mei-button-primary');
        saveBtn.style.cssText = 'flex-grow: 0; flex-shrink: 0; padding: 10px 15px; width: 100px;';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '閉じる';
        closeBtn.classList.add('mei-button', 'mei-button-secondary');
        closeBtn.style.cssText = 'flex-grow: 0; flex-shrink: 0; padding: 10px 15px; width: 100px;';
        closeBtn.onclick = () => {
            document.removeEventListener('keydown', escListener);
            overlay.remove();
        };

        // グループにボタンを追加
        saveCloseGroup.appendChild(saveBtn);
        saveCloseGroup.appendChild(closeBtn);

        // 最終フッターに左のボタンと右のグループを追加
        finalFooter.appendChild(rvcSettingsBtn);
        finalFooter.appendChild(saveCloseGroup);
        panel.appendChild(finalFooter);

        // DOMにパネルとオーバーレイを追加
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        // 初期表示時に実行
        updateSpeakerNameDisplay(config.speakerId);

        saveBtn.addEventListener('click', () => {
            const newSpeakerId = parseInt(speakerInput.value, 10);
            const newApiUrl = apiInput.value.trim();
            const newAutoPlay = autoPlayInput.checked;
            const newShortcutKey = keyInput.value.trim();
            const minTextLengthInput = document.getElementById('minTextLength');
            const newMinTextLength = parseInt(minTextLengthInput.value, 10);
            const maxChunksInput = document.getElementById('maxChunks');
            const newMaxChunks = parseInt(maxChunksInput.value, 10);

            if (isNaN(newSpeakerId) || newSpeakerId < 0) {
                showToast('スピーカーIDは半角数字で、0以上の値を入力してね！', false);
                return;
            }
            if (newShortcutKey === 'キーを押してください...' || newShortcutKey.includes('は必須よ！') || newShortcutKey.includes('じゃないわ...')) {
                showToast('ショートカットキーを正しく設定してね！', false);
                return;
            }
            if (isNaN(newMinTextLength) || newMinTextLength < 1 || newMinTextLength > 10000) {
                showToast('最小読み上げ文字数は半角数字で、1～10,000の範囲を入力してね！', false);
                return;
            }
            if (isNaN(newMaxChunks) || newMaxChunks < 10 || newMaxChunks > 1000) {
                showToast(`最大分割数は半角数字で、10～1,000の範囲を入力してね！`, false);
                return;
            }
            // 最小文字数が「最大チャンク数 × DEFAULT_CHUNK_SIZE(目安)」を明らかに超えている場合の警告
            if (newMinTextLength > (newMaxChunks * DEFAULT_CHUNK_SIZE)) {
                showToast('最小文字数が大きすぎて、設定された最大分割数では一生再生されないわよ！', false);
                return;
            }

            const newConfig = {
                ...config, // 既存のRVC設定を保持
                speakerId: newSpeakerId,
                apiUrl: newApiUrl,
                autoPlay: newAutoPlay,
                minTextLength: newMinTextLength,
                maxChunks: newMaxChunks,
                shortcutKey: newShortcutKey,
            };

            GM_setValue(STORE_KEY, newConfig);
            config = newConfig;
            showToast('設定を保存したわ！', true);
            document.removeEventListener('keydown', escListener);
            overlay.remove();
        });
    }

    // ========= RVC連携 設定UI =========
    function openRvcSettings() {
        if (document.getElementById('mei-settings-overlay')) {
            return;
        }

        const oldRvcModel = config.rvcModel;
        const oldRvcEnabled = config.rvcEnabled;

        // --- オーバーレイとパネルの基本設定 ---
        const overlay = document.createElement('div');
        overlay.id = 'mei-settings-overlay';
        overlay.style.cssText = 'display: flex; justify-content: center; align-items: center;';
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
                document.removeEventListener('keydown', escListener);
            }
        });

        const escListener = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                overlay.remove();
                document.removeEventListener('keydown', escListener);
            }
        };
        document.addEventListener('keydown', escListener);

        const panel = document.createElement('div');
        panel.id = 'mei-settings-panel';
        panel.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        const title = document.createElement('h2');
        title.textContent = `🔊 RVC連携 設定 (v${SCRIPT_VERSION})`;
        title.style.cssText = 'margin-top: 0; border-bottom: 1px solid #444; padding-bottom: 10px; margin-bottom: 20px; color: #8ab4f8; font-size: 1.5em;';
        panel.appendChild(title);

        // ----------------------------------------------------
        // 🌟 RVC ON/OFF スイッチ 🌟
        // ----------------------------------------------------
        const rvcEnableGroup = document.createElement('div');
        rvcEnableGroup.style.cssText = 'display: flex; align-items: center; margin-bottom: 20px; border-bottom: 1px solid #444; padding-bottom: 15px;';

        const rvcEnableInput = document.createElement('input');
        rvcEnableInput.type = 'checkbox';
        rvcEnableInput.id = 'rvcEnabled';
        rvcEnableInput.checked = config.rvcEnabled || false;
        rvcEnableInput.style.cssText = 'width: 20px; height: 20px; margin-right: 10px; flex-shrink: 0;';
        rvcEnableGroup.appendChild(rvcEnableInput);

        const rvcEnableLabel = document.createElement('label');
        rvcEnableLabel.textContent = 'RVC連携を有効にする (ON: RVCを使用 | OFF: VOICEVOXを使用)';
        rvcEnableLabel.setAttribute('for', 'rvcEnabled');
        rvcEnableLabel.style.cssText = 'font-weight: bold; color: #e8eaed; cursor: pointer;';
        rvcEnableGroup.appendChild(rvcEnableLabel);
        panel.appendChild(rvcEnableGroup);

        // ----------------------------------------------------
        // 🌟 RVC設定項目 🌟
        // ----------------------------------------------------

        // --- 設定項目を横並びにする共通スタイル ---
        const createSettingGroup = (labelText, inputId, value, type = 'text', width = '100%', min = null, max = null, step = null, placeholder = '') => {
            const group = document.createElement('div');
            group.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;';

            const label = document.createElement('label');
            label.setAttribute('for', inputId);
            label.style.cssText = 'font-weight: bold; color: #9aa0a6; white-space: nowrap; margin-right: 15px; flex-shrink: 0;';
            label.textContent = labelText;
            group.appendChild(label);

            const input = document.createElement('input');
            input.type = type === 'file' ? 'text' : type;
            input.id = inputId;
            input.value = value;
            input.classList.add('mei-input-field');
            input.style.width = width;
            if (min !== null) {
                input.min = min;
            }
            if (max !== null) {
                input.max = max;
            }
            if (step !== null) {
                input.step = step;
            }
            if (placeholder) {
                input.setAttribute('placeholder', placeholder);
            }
            if (type === 'number') {
                input.style.textAlign = 'right';
            }
            input.setAttribute('autocomplete', 'off');

            group.appendChild(input);
            return {
                group,
                input,
            };
        };

        // --- セレクトボックスを作成する共通スタイル ---
        const createSettingSelect = (labelText, selectId, currentValue, options) => {
            const group = document.createElement('div');
            group.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;';

            const label = document.createElement('label');
            label.setAttribute('for', selectId);
            label.style.cssText = 'font-weight: bold; color: #9aa0a6; white-space: nowrap; margin-right: 15px; flex-shrink: 0;';
            label.textContent = labelText;
            group.appendChild(label);

            const select = document.createElement('select');
            select.id = selectId;
            select.classList.add('mei-input-field');
            select.style.width = '240px';
            // options は { value: '値', text: '表示名' } の配列を想定するわ
            options.forEach(opt => {
                const option = document.createElement('option');
                option.value = opt.value;
                option.textContent = opt.text;
                if (currentValue === opt.value) {
                    option.selected = true;
                }
                select.appendChild(option);
            });

            group.appendChild(select);
            return {
                group,
                select,
            };
        };

        // RVC API URL
        const rvcApi = createSettingGroup('RVC WebUI URL:', 'rvcApiUrl', config.rvcApiUrl, 'url', '100%', null, null, null, '例: http://localhost:7897/');
        panel.appendChild(rvcApi.group);

        // --- ヘルパー関数: オプションをクリアする ---
        const clearOptions = (element) => {
            while (element.firstChild) {
                element.removeChild(element.firstChild);
            }
        };

        // --- モデルとインデックスの選択肢をAPIから取得し更新する ---
        async function updateRvcChoices(buttonElement) {
            const refreshUrl = `${config.rvcApiUrl.replace(/\/$/, '')}/run/infer_refresh`;

            try {
                const response = await new Promise((resolve, reject) => {
                    const xhr = GM_xmlhttpRequest({
                        method: 'POST',
                        url: refreshUrl,
                        data: JSON.stringify({
                            data: [],
                        }),
                        headers: {
                            "Content-Type": "application/json",
                        },
                        responseType: 'json',
                        timeout: 10000,
                        onload: (res) => resolve(res),
                        onerror: () => reject(new Error('RVC refresh connection error.')),
                        ontimeout: () => reject(new Error('RVC refresh timeout.')),
                    });
                });

                if (response.status !== 200 || !response.response || !response.response.data) {
                    throw new Error(`RVC refresh failed (Status: ${response.status})`);
                }

                const data = response.response.data;
                const modelUpdate = data[0];
                const indexUpdate = data[1];

                // ----------------------------------------------------
                // A. モデル選択肢の更新 (Select Box)
                // ----------------------------------------------------
                const modelChoices = modelUpdate && modelUpdate.choices ? modelUpdate.choices : [];
                const currentModel = rvcModel.select.value;

                clearOptions(rvcModel.select);
                let modelFound = false;

                modelChoices.forEach(choice => {
                    const [value, text,] = Array.isArray(choice) ? choice : [choice, choice,];
                    const option = document.createElement('option');
                    option.value = value;
                    option.textContent = text;
                    if (value === currentModel) {
                        option.selected = true;
                        modelFound = true;
                    }
                    rvcModel.select.appendChild(option);
                });

                if (!modelFound) {
                    const option = document.createElement('option');
                    option.value = currentModel;
                    option.textContent = currentModel;
                    option.selected = true;
                    rvcModel.select.prepend(option);
                }

                console.log(`[RVC Config] モデルの選択肢を ${modelChoices.length} 件更新しました。`);

                // ----------------------------------------------------
                // B. インデックス選択肢の更新 (Select Box)
                // ----------------------------------------------------
                const indexChoices = indexUpdate && indexUpdate.choices ? indexUpdate.choices : [];
                const currentIndex = rvcIndex.select.value; // 現在の値を取得

                clearOptions(rvcIndex.select);

                // 【重要】[None]オプションを先頭に追加するわ
                const noneOption = document.createElement('option');
                noneOption.value = '';
                noneOption.textContent = '[None] 使用しない';
                if (currentIndex === '') {
                    noneOption.selected = true;
                }
                rvcIndex.select.appendChild(noneOption);

                let indexFound = false;
                indexChoices.forEach(choice => {
                    const [value,] = Array.isArray(choice) ? choice : [choice,];
                    const option = document.createElement('option');
                    option.value = value;
                    option.textContent = value;

                    if (value === currentIndex && currentIndex !== '') {
                        option.selected = true;
                        indexFound = true;
                    }
                    rvcIndex.select.appendChild(option);
                });

                // 現在の値が見つからなかった場合、その値をオプションとして保持
                if (!indexFound && currentIndex !== '') {
                    const option = document.createElement('option');
                    option.value = currentIndex;
                    option.textContent = currentIndex;
                    option.selected = true;
                    rvcIndex.select.appendChild(option);
                }

                console.log(`[RVC Config] インデックスの選択肢を ${indexChoices.length} 件更新しました。`);

                // 🎊 成功！ボタンを元に戻す
                buttonElement.textContent = '✅ 更新完了';
                await new Promise(resolve => setTimeout(resolve, 1000)); // 1秒間だけ成功表示

            } catch (error) {
                console.error('[RVC Config] ❌ モデル/インデックスリストの取得に失敗しました:', error);

                // 😢 失敗！ボタンにエラーを表示
                buttonElement.textContent = '❌ 取得失敗';
                await new Promise(resolve => setTimeout(resolve, 2000)); // 2秒間エラー表示

            } finally {
                // どちらの結果でも最終的に元の表示に戻す
                buttonElement.disabled = false;
                buttonElement.textContent = '🔄 リストを更新';
            }
        }

        // --- RVC MODEL NAME ---
        const rvcModelOptions = [{
            value: config.rvcModel,
            text: config.rvcModel,
        },];
        const rvcModel = createSettingSelect('モデルファイル名 (.pth):', 'rvcModel', config.rvcModel, rvcModelOptions);
        rvcModel.select.style.height = '36px'; // align-items: center; が効きにくい場合の保険として、selectの高さをボタン(+2px)に合わせる

        // --- リフレッシュボタン ---
        const rvcRefreshButton = document.createElement('button');
        rvcRefreshButton.id = 'rvcRefreshButton';
        rvcRefreshButton.textContent = '🔄 リストを更新';
        rvcRefreshButton.style.cssText = 'margin-top: 4px; margin-left: 8px; padding: 4px 6px; font-size: 12px; width:100px; height:34px; background: #333; color: white; border: 1px solid #5f6368; border-radius: 8px; cursor: pointer; flex-shrink: 0;';

        // セレクトボックスの隣にボタンを追加
        rvcModel.group.appendChild(rvcRefreshButton);
        rvcRefreshButton.addEventListener('click', (e) => {
            e.preventDefault();
            if (rvcRefreshButton.disabled) {
                return;
            }
            rvcRefreshButton.disabled = true;
            rvcRefreshButton.textContent = '取得中...';
            updateRvcChoices(rvcRefreshButton);
        });

        panel.appendChild(rvcModel.group);

        // --- RVC INDEX NAME ---
        const rvcIndexOptions = [{
            value: '',
            text: '[None] 使用しない', // クリアするための選択肢
        }, {
            value: config.rvcIndex,
            text: config.rvcIndex,
        },
        ];
        const rvcIndex = createSettingSelect(
            'インデックスファイル名 (.index):',
            'rvcIndexSelect', // selectのID
            config.rvcIndex,
            rvcIndexOptions
        );
        rvcIndex.select.style.height = '36px'; // selectの高さ調整
        rvcIndex.select.style.width = '240px'; // 幅を合わせる
        panel.appendChild(rvcIndex.group);

        // --- 起動時にリストを自動で更新！ ---
        setTimeout(() => {
            rvcRefreshButton.disabled = true;
            rvcRefreshButton.textContent = '取得中...';
            updateRvcChoices(rvcRefreshButton);
        }, 100);

        // RVC PITCH SHIFT
        const rvcPitch = createSettingGroup('ピッチ変更 (-12～12):', 'rvcPitch', config.rvcPitch, 'number', '80px', '-12', '12', '1');
        panel.appendChild(rvcPitch.group);

        // RVC RATIO（検索特徴率）
        const rvcRatio = createSettingGroup('検索特徴率 (0.0～1.0) [0.75]:', 'rvcRatio', config.rvcRatio, 'number', '80px', '0.0', '1.0', '0.1');
        panel.appendChild(rvcRatio.group);

        // RVC ALGORITHM
        const rvcAlgorithmGroup = document.createElement('div');
        rvcAlgorithmGroup.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;';

        const rvcAlgorithmLabel = document.createElement('label');
        rvcAlgorithmLabel.setAttribute('for', 'rvcAlgorithm');
        rvcAlgorithmLabel.style.cssText = 'font-weight: bold; color: #9aa0a6; white-space: nowrap; margin-right: 15px; flex-shrink: 0;';
        rvcAlgorithmLabel.textContent = 'アルゴリズム (pm|harvest|crepe|rmvpe):';
        rvcAlgorithmGroup.appendChild(rvcAlgorithmLabel);

        const rvcAlgorithmSelect = document.createElement('select');
        rvcAlgorithmSelect.id = 'rvcAlgorithm';
        rvcAlgorithmSelect.style.width = '100px';
        rvcAlgorithmSelect.classList.add('mei-input-field');
        ['pm', 'harvest', 'crepe', 'rmvpe',].forEach(alg => {
            const option = document.createElement('option');
            option.value = alg;
            option.textContent = alg;
            if (config.rvcAlgorithm === alg) {
                option.selected = true;
            }
            rvcAlgorithmSelect.appendChild(option);
        });
        rvcAlgorithmGroup.appendChild(rvcAlgorithmSelect);
        panel.appendChild(rvcAlgorithmGroup);

        const rvcResample = createSettingGroup('リサンプリング周波数 (0～48000):', 'rvcResample', config.rvcResample, 'number', '80px', '0', '48000', '100');
        panel.appendChild(rvcResample.group);
        // リサンプリングの説明を追加するクールな作業
        const resampleDesc = document.createElement('p');
        resampleDesc.style.cssText = 'color: #7b7d82; font-size: 0.8em; margin: -10px 0 20px 0; padding-left: 20px;';
        resampleDesc.textContent = '入力音声のリサンプリング周波数よ。（推奨値：48000）';
        panel.appendChild(resampleDesc);

        // ----------------------------------------------------
        // 🌟 最終フッターグループ 🌟
        // ----------------------------------------------------

        const finalFooter = document.createElement('div');
        finalFooter.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-top: 20px;';

        // 🔊 VOICEVOX連携 設定ボタン
        const vvSettingsBtn = document.createElement('button');
        vvSettingsBtn.textContent = '🔊 VOICEVOX連携';
        vvSettingsBtn.classList.add('mei-button', 'mei-button-secondary');
        vvSettingsBtn.style.cssText = 'flex-grow: 0; flex-shrink: 0; padding: 10px 15px; margin-right: auto;';
        vvSettingsBtn.addEventListener('click', () => {
            document.removeEventListener('keydown', escListener);
            overlay.remove();
            openSettings();
        });

        const saveCloseGroup = document.createElement('div');
        saveCloseGroup.style.cssText = 'display: flex; gap: 10px;';

        // 保存ボタン
        const saveBtn = document.createElement('button');
        saveBtn.textContent = '保存';
        saveBtn.classList.add('mei-button', 'mei-button-primary');
        saveBtn.style.cssText = 'flex-grow: 0; flex-shrink: 0; padding: 10px 15px; width: 100px;';

        // 閉じるボタン
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '閉じる';
        closeBtn.classList.add('mei-button', 'mei-button-secondary');
        closeBtn.style.cssText = 'flex-grow: 0; flex-shrink: 0; padding: 10px 15px; width: 100px;';
        closeBtn.onclick = () => {
            document.removeEventListener('keydown', escListener);
            overlay.remove();
        };

        // グループにボタンを追加
        saveCloseGroup.appendChild(saveBtn);
        saveCloseGroup.appendChild(closeBtn);

        // 最終フッターに左のボタンと右のグループを追加
        finalFooter.appendChild(vvSettingsBtn);
        finalFooter.appendChild(saveCloseGroup);
        panel.appendChild(finalFooter);

        // --- 保存処理 ---
        saveBtn.addEventListener('click', () => {
            const newRvcApiUrl = rvcApi.input.value.trim();
            const newRvcModel = rvcModel.select.value.trim();
            const newRvcIndex = rvcIndex.select.value.trim();
            const newRvcPitch = parseFloat(rvcPitch.input.value);
            const newRvcRatio = parseFloat(rvcRatio.input.value);
            const newrvcAlgorithm = rvcAlgorithmSelect.value;
            const newRvcResample = parseInt(document.getElementById('rvcResample').value);
            const newRvcEnabled = rvcEnableInput.checked;

            // バリデーション
            if (newRvcApiUrl === '' || newRvcModel === '' ||
                isNaN(newRvcPitch) || newRvcPitch < -12 || newRvcPitch > 12 ||
                isNaN(newRvcRatio) || newRvcRatio < 0 || newRvcRatio > 1 ||
                isNaN(newRvcResample) || newRvcResample < 0 || newRvcResample > 48000) {
                showToast('全項目を正しく入力してね！', false);
                return;
            }

            const newConfig = {
                ...config,
                rvcEnabled: newRvcEnabled,
                rvcApiUrl: newRvcApiUrl,
                rvcModel: newRvcModel,
                rvcIndex: newRvcIndex,
                rvcPitch: newRvcPitch,
                rvcRatio: newRvcRatio,
                rvcAlgorithm: newrvcAlgorithm,
                rvcResample: newRvcResample,
            };

            GM_setValue(STORE_KEY, newConfig);
            config = newConfig;
            // RVCが有効なら、設定変更直後にロード
            if (newRvcEnabled) {
                loadRvcModel(config);
            }

            showToast('✅ RVC連携設定を保存したわ！', true);

            document.removeEventListener('keydown', escListener);
            overlay.remove();
        });

        // DOMにパネルとオーバーレイを追加
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
    }

    // グローバルキーイベントリスナー
    function handleGlobalKeyDown(e) {
        // IME入力中は処理しない
        if (e.isComposing || e.keyCode === 229) {
            return;
        }

        // 設定が読み込まれていない、または設定が無効な場合は何もしない
        if (!config || !config.shortcutKey) {
            return;
        }

        const isControl = e.ctrlKey || e.metaKey; // CtrlまたはCommand
        const isAlt = e.altKey;
        const isShift = e.shiftKey;
        const button = document.getElementById('convertButton');

        // ボタンが存在しないか、設定パネルが開いている場合は何もしない
        if (!button || document.getElementById('mei-settings-overlay')) {
            return;
        }

        // Keyを大文字化
        let key = e.key;
        if (key.length === 1) {
            key = key.toUpperCase();
        } else if (key === ' ') {
            key = 'Space';
        }

        let pressedShortcut = '';

        if (isControl) {
            pressedShortcut += 'Ctrl+';
        } // 'Ctrl' に統一
        if (isAlt) {
            pressedShortcut += 'Alt+';
        }
        if (isShift) {
            pressedShortcut += 'Shift+';
        }

        // 最後のキーが修飾キーではないことを確認（Control, Shift, Alt, Meta）
        if (key !== 'Control' && key !== 'Shift' && key !== 'Alt' && key !== 'Meta') {
            pressedShortcut += key;
        }

        // キーが一致したら実行
        if (pressedShortcut === config.shortcutKey) {
            e.preventDefault(); // デフォルトの動作を抑制（ブラウザショートカットなど）
            e.stopPropagation();

            // 再生中または合成中なら停止、それ以外なら再生
            if (isPlaying) {
                stopPlayback();
            } else if (isPause && audioContext) {
                resumeContext();
            } else if (isConversionStarting || currentXhrs.length > 0) {
                stopConversion();
            } else {
                // 再生開始。手動操作なので isAutoPlay は false
                startConversion(false);
            }
        }
    }

    // 再生・合成中の処理をすべてリセットし、ボタンを初期状態に戻す関数
    function resetOperation(isStopRequest = false) {
        //  トーストを即座にクリアするわ！
        if (typeof toastTimeoutId !== 'undefined' && toastTimeoutId) {
            clearTimeout(toastTimeoutId);
            toastTimeoutId = null; // 自動非表示タイマーをキャンセル
        }
        const toastId = 'spitch-toast';
        const existingToast = document.getElementById(toastId);
        if (existingToast) {
            existingToast.remove();
        }

        // 1. Audioリセット
        const wasPlaying = currentAudio !== null; // リセット前の状態をチェック
        if (currentAudio) {
            currentAudio.pause();
            currentAudio.src = '';
            currentAudio = null;
        }
        isPlaying = false;

        // 2. XHR/合成リセット（中断）
        const wasConverting = currentXhrs.length > 0; // リセット前の状態をチェック
        if (wasConverting) {
            currentXhrs.forEach(xhr => {
                if (xhr && xhr.readyState !== 4) { // 完了していなければ中断
                    xhr.abort();
                }
            });
            currentXhrs = []; // 配列を空に戻すわ！
        }

        isConversionStarting = false;

        // 3. メッセージの決定と表示
        if (isStopRequest) { // 手動で停止ボタンが押された場合のみメッセージを出す
            if (wasConverting) {
                // 合成中だった場合は「中断」
                showToast('■ 音声合成を中断したわ', false);
            } else if (wasPlaying) {
                // 合成は終わって再生中だった場合は「停止」
                showToast('■ 音声再生を停止しました', false);
            }
            // その他の場合はメッセージなし
        }

        // 4. ボタンリセット
        updateButtonState();

        // サンプルボタンが合成中・再生中だった場合もリセット
        const sampleButton = document.getElementById('mei-sample-play-btn');
        if (sampleButton && sampleButton.textContent === '🔇 再生停止') {
            resetSampleButtonState(sampleButton);
        } else if (sampleButton && sampleButton.textContent === '⏰ 合成中...') {
            resetSampleButtonState(sampleButton);
        }
    }

    // 停止処理
    function stopConversion() {
        if (isPlaying || currentXhrs.length > 0) {
            resetOperation(true); // 再生中または合成中の停止
        } else {
            resetOperation(); // 念のためリセット
        }
    }

    /**
     * 最後のGeminiの回答パネルから、読み上げ用のテキストを抽出する。
     * @returns {string} - 抽出されたクリーンなテキスト。処理中断時は空文字列。
     */
    function getGeminiAnswerText() {
        let allResponseContainers = [];
        for (const selector of SELECTORS_RESPONSE) {
            const containers = document.querySelectorAll(selector.container);
            if (containers.length > 0) {
                allResponseContainers = containers;
                break; // 最初にマッチしたセレクタで決定
            }
        }
        if (allResponseContainers.length === 0) {
            return '';
        }

        /* * * デバッグコード: detection 検出時にDOM構造を出力 * * */
        if (DEBUG_DETECTION) {
            const detection = 'お待ちください';
            const detect_length = 100;
            const rawText = clonedContainer.innerText || '';
            if (rawText.includes(detection)) {
                // 検出された回答パネル（クローン）のouterHTMLを出力。
                console.log(`[Debug] [${getFormattedDateTime()}] 【検出された回答パネルのHTML】(innerText): \n${rawText.substring(0, detect_length).replace(/\n/g, ' ')}...`);
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
            }
        }
        /* * * デバッグコードここまで * * */

        // 最後の回答パネルを取得
        const textContainer = allResponseContainers[allResponseContainers.length - 1];
        if (!textContainer) {
            return '';
        }

        // DOMを汚染しないようにクローンを作成
        const clonedContainer = textContainer.cloneNode(true);

        // 応答生成中｜停止のステータスチェック
        const isInterrupted = SELECTORS_TO_INTERRUPT.some(selector => {
            return clonedContainer.querySelector(selector);
        });
        if (isInterrupted) {
            return '';
        }

        // すべての除去対象要素をループで探し、除去する（グローバル配列を使用！）
        SELECTORS_TO_REMOVE.forEach(selector => {
            const elements = clonedContainer.querySelectorAll(selector);
            elements.forEach(element => element.remove());
        });

        // innerTextを取る「前」に「間」を仕込むわ
        const blocks = clonedContainer.querySelectorAll('p, th, td, li, h1, h2, h3, h4, h5, h6');
        blocks.forEach(block => {
            // block.textContent だと子要素（bタグなど）のテキストも全部拾えるわ
            const content = block.textContent.trim();

            // 中身があって、かつ末尾が句読点で終わっていない場合だけ「、」を足す
            if (content && !/[。？！…!?.]$/.test(content)) {
                // block.append('、') を使うと、既存のHTML構造を壊さずに末尾にテキストを追加できるわよ
                block.insertAdjacentText('beforeend', '、');
            }
        });

        let text = clonedContainer.innerText || '';

        // 1. コードブロック、コメント、タイトル記号の除去
        // g: グローバル検索, i: 大文字小文字を区別しない, m: 複数行モード
        text = text.replace(/```[a-z]*[\s\S]*?```|^\s*[#*]+\s/gim, ' ');

        // テキストコンテンツによる中断チェック
        if (text.startsWith('お待ちください')) {
            return '';
        }
        if (text.includes('Analyzing input...') || text.includes('Generating response...')) {
            return '';
        }

        // 2. 改行（\n）を「、」に置換して、物理的な「間」を確保するわ！
        text = text.replace(/[\n|]+/g, '、');

        // 3. その他のマークダウン記号の除去
        text = text.replace(/(\*{1,2}|_{1,2}|~{1,2}|#|\$|>|-|\[.*?\]\(.*?\)|`|\(|\)|\[|\]|<|>|\\|:|\?|!|;|=|\+|\|)/gim, ' ');

        // 4. 連続する空白（全角・タブ含む）を1つにまとめる
        text = text.replace(/[ \u3000\t]{2,}/g, ' ');

        // 5. 連続する句読点（。。 や ！。 など）を1つにまとめる
        text = text.replace(/([.!?、。？！]{2,})/g, function(match, p1) {
            return p1.substring(0, 1);
        });

        if (DEBUG_TEXT) {
            console.log(`=== [Debug] [${getFormattedDateTime()}] Before Remove Regex ===\n${text.trim()}\n============`);
        }

        // 6. 定型文・NGワードの除去
        TEXTS_TO_REMOVE_REGEX.forEach(regexString => {
            // gフラグ（グローバル）を追加し、全文からマッチしたものを全て除去するわ
            const regex = new RegExp(regexString, 'gi');
            // 除去した箇所を空白に置き換えて、後のクリーンアップで連続空白をまとめるわ
            text = text.replace(regex, ' ');
        });

        if (DEBUG_TEXT) {
            console.log(`------ [Debug] [${getFormattedDateTime()}] return text.trim() ------\n${text.trim()}\n------------------`);
        }

        // 最後に、前後の余計なスペースをトリミングして完成！
        return text.trim();
    }

    // サンプル再生関連
    function resetSampleButtonState(button) {
        if (button) {
            button.textContent = '🔊 サンプル再生';
            button.style.backgroundColor = '#5cb85c'; // Green
            button.onclick = () => startSampleConversion();
        }
    }

    /**
     * VOICEVOXからテスト音声を取得し、必要に応じてRVC変換を行い、再生するわ。
     * @param {object} audioQuery - VOICEVOXから取得したオーディオクエリオブジェクト
     * @param {HTMLButtonElement} button - サンプル再生ボタン
     * @param {string} text - テストに用いたテキスト
     * @param {number} speakerId - 使用したスピーカーID
     */
    function synthesizeSampleAudio(audioQuery, button, text, speakerId) {
        showToast(`テストテキスト合成中...`, null);

        const currentConfig = GM_getValue(STORE_KEY, config);
        const synthesizeUrl = `${currentConfig.apiUrl}/synthesis?speaker=${speakerId}`;

        const xhr = GM_xmlhttpRequest({
            method: 'POST',
            url: synthesizeUrl,
            headers: {
                'Content-Type': 'application/json',
            },
            data: JSON.stringify(audioQuery),
            responseType: 'blob',
            onload: async function(response) {
                currentXhrs = currentXhrs.filter(item => item !== xhr); // 完了したXHRを配列から削除

                if (response.status === 200 && response.response) {
                    let playableBlob = response.response; // VOICEVOX original Blob
                    let isRvcSuccess = false;

                    // --- RVC変換ロジック ---
                    if (currentConfig.rvcEnabled) {
                        try {
                            showToast('RVC変換中...', null);

                            // 1. BlobをArrayBufferに変換
                            const arrayBuffer = await playableBlob.arrayBuffer();

                            // 2. RVC変換を実行
                            const rvcBuffer = await requestRvcConversion(arrayBuffer, currentConfig);

                            // 3. Blobに戻す
                            playableBlob = new Blob([rvcBuffer,], { type: 'audio/wav', });

                            isRvcSuccess = true;
                            showToast('RVC変換完了！再生するわ！', true);

                        } catch (rvcError) {
                            // 【フォールバック】RVC変換失敗時の処理
                            console.error('[Sample Playback] ❌ RVC変換失敗（フォールバック）:', rvcError);
                            showToast('😭 RVC連携失敗！VOICEVOXオリジナル音声で代替再生するわ。', false);
                            // playableBlob は VOICEVOX original Blob のまま（フォールバック）
                        }
                    }

                    // --- 再生処理 (playableBlobがRVC変換済みかオリジナル音声になる) ---
                    const audioUrl = URL.createObjectURL(playableBlob);
                    const audio = new Audio(audioUrl);
                    currentAudio = audio;
                    isPlaying = true;

                    audio.onplay = () => {
                        if (button) {
                            button.textContent = '🔇 再生停止';
                            button.style.backgroundColor = '#dc3545'; // Red
                        }
                    };

                    // AudioContextを使わないので、Autoplayブロックは発生しにくいけど、一応エラーハンドリングは任せるわ
                    audio.play().catch(e => {
                        console.error('オーディオ再生エラー:', e);
                        showToast('😭 自動再生ブロック。ブラウザのどこかをクリックしてからもう一度試してみて！', false);
                        resetOperation();
                        resetSampleButtonState(button);
                    });

                    audio.onended = () => {
                        URL.revokeObjectURL(audioUrl);
                        // 再生終了時に状態をリセット（メインボタンは操作しない）
                        resetOperation();
                        resetSampleButtonState(button); // サンプルボタンを再開表示に戻す
                    };

                    const finalToast = isRvcSuccess
                        ? 'RVCテスト音声再生中よ！'
                        : 'テスト音声再生中よ！';
                    showToast(finalToast, true);

                } else {
                    // VOICEVOX合成失敗
                    showToast(`VOICEVOX合成に失敗したわ... (Status: ${response.status})`, false);
                    console.error('VOICEVOX Synthesize Error:', response);
                    resetOperation();
                    resetSampleButtonState(button);
                }
            },
            onerror: function(error) {
                currentXhrs = currentXhrs.filter(item => item !== xhr); // 完了したXHRを配列から削除
                showToast('テスト音声の合成中にエラーが発生したわ。', false);
                console.error('VOICEVOX Synthesize Connection Error:', error);
                resetOperation();
                resetSampleButtonState(button);
            },
        });
        currentXhrs.push(xhr); // XHRオブジェクトを保存
    }

    function startSampleConversion() {
        const SAMPLE_TEXT = '音声のテストだよ！この声で読み上げするよ！';
        const button = document.getElementById('mei-sample-play-btn');
        const speakerIdInput = document.getElementById('speakerId');

        if (isPlaying || currentXhrs.length > 0) {
            showToast('今は再生中か合成中よ。停止ボタンで止めてね。', false);
            return;
        }

        // 入力値を取得し、不正な値ならエラー
        if (!speakerIdInput) {
            return;
        } // 念の為のガード
        const currentSpeakerId = parseInt(speakerIdInput.value, 10);

        if (isNaN(currentSpeakerId) || currentSpeakerId < 0) {
            showToast('スピーカーIDが不正よ！半角数字を確認してね。', false);
            return;
        }

        const currentConfig = GM_getValue(STORE_KEY, config);

        // 合成中の状態
        if (button) {
            button.textContent = '⏰ 合成中...';
            button.style.backgroundColor = '#6c757d';
            button.onclick = () => stopConversion(); // グローバル停止関数を呼ぶ
        }

        const audioQueryUrl = `${currentConfig.apiUrl}/audio_query`;
        const queryParams = new URLSearchParams({
            text: SAMPLE_TEXT,
            speaker: currentSpeakerId,
        });

        const xhr = GM_xmlhttpRequest({
            method: 'POST',
            url: `${audioQueryUrl}?${queryParams.toString()}`,
            headers: {
                'Content-Type': 'application/json',
            },
            onload: function(response) {
                currentXhrs = currentXhrs.filter(item => item !== xhr); // 完了したXHRを配列から削除
                if (response.status === 200) {
                    const audioQuery = JSON.parse(response.responseText);
                    synthesizeSampleAudio(audioQuery, button, SAMPLE_TEXT, currentSpeakerId);
                } else {
                    showToast(`VOICEVOXとの連携に失敗したわ... (Status: ${response.status})`, false);
                    console.error('VOICEVOX Query Error:', response);
                    resetOperation();
                    resetSampleButtonState(button);
                }
            },
            onerror: function(error) {
                currentXhrs = currentXhrs.filter(item => item !== xhr); // 完了したXHRを配列から削除
                showToast('VOICEVOXエンジンに接続できないわ... 起動しているか確認してね。', false);
                console.error('VOICEVOX Connection Error:', error);
                resetOperation();
                resetSampleButtonState(button);
            },
        });
        currentXhrs.push(xhr); // XHRオブジェクトを保存
    }

    // ========= Download =========

    /**
     * Blobデータを指定したファイル名でダウンロードする
     * @param {Blob} blob Blobオブジェクト
     * @param {string} filename ダウンロードファイル名
     */
    function downloadBlob(blob, filename) {
        // 1. BlobからURLを生成 (メモリ上のオブジェクトを参照する一時的なURL)
        const url = URL.createObjectURL(blob);

        // 2. 仮想的なアンカー（<a>）要素を作成
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;

        // 3. クリックイベントを発生させてダウンロード開始
        document.body.appendChild(a);
        a.click();

        // 4. 後処理（メモリ解放と要素削除）
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // console.log(`${filename} のダウンロードを開始しました。`);
    }

    // ダウンロード
    async function startVoiceDownload() {
        try {
            let text = getGeminiAnswerText();
            if (!text || text.trim() === '') {
                // showToast('回答テキストが取得できなかったか、全て除去されたわ...', false);
                return;
            }

            // キャッシュチェック
            const currentConfig = GM_getValue(STORE_KEY, config);
            const requestCacheKey = generateCacheKey(text, currentConfig);
            const cachedHash = GM_getValue(LAST_CACHE_HASH, null);

            if (requestCacheKey === cachedHash) {
                const cachedData = GM_getValue(LAST_CACHE_DATA, null); // Base64 URI
                if (cachedData) {
                    const wavBlob = base64UriToBlob(cachedData, 'audio/wav'); // 変換
                    downloadBlob(wavBlob, `neon_spitch_${getFormattedDateTime()}.wav`);
                }
            }
        } catch (e) {
            console.error("[Cache Download] ダウンロード処理でエラーが発生しました:", e);
        }
    }

    // ========= RVC連携用ヘルパー関数 =========

    /**
     * ArrayBufferをBase64文字列に変換するヘルパー関数（同期）
     * @param {ArrayBuffer} buffer
     * @returns {string} Base64文字列
     */
    function arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        // Base64に変換して返すわ
        return btoa(binary);
    }

    /**
     * Base64 URI (またはプレーンなBase64文字列) を Blob オブジェクトに変換する
     * @param {string} base64WavData - Base64 URIまたはBase64文字列
     * @param {string} defaultMimeType - Base64 URIにMIMEタイプがない場合のデフォルト (例: 'audio/wav')
     * @returns {Blob} Blobオブジェクト
     */
    function base64UriToBlob(base64WavData, defaultMimeType = 'audio/wav') {
        let base64 = base64WavData;
        let mimeType = defaultMimeType;

        // 1. Data URIヘッダーの処理 (Data URI形式: data:MIME/TYPE;base64,DATA)
        if (base64.startsWith('data:')) {
            const parts = base64.split(',');
            base64 = parts[1];

            // ヘッダーからMIMEタイプを抽出
            const header = parts[0];
            const match = header.match(/:(.*?)(;|$)/);
            if (match && match[1]) {
                mimeType = match[1];
            }
        }

        // 2. Base64デコードとBlob生成
        const binary = atob(base64);
        const len = binary.length;
        const array = new Uint8Array(len);

        for (let i = 0; i < len; i++) {
            array[i] = binary.charCodeAt(i);
        }

        return new Blob([array.buffer,], {
            type: mimeType,
        });
    }

    // ========= RVC連携 音声合成関数 =========

    /**
     * VOICEVOXのArrayBuffer（WAVデータ）をRVCサーバーで変換し、RVC変換後の音声データをArrayBuffer形式で返すわ。
     * GradioスタイルのAPIエンドポイントに対応
     * @param {ArrayBuffer} voicevoxArrayBuffer - VOICEVOXから合成されたWAV ArrayBuffer
     * @param {Object} currentConfig - 現在の設定オブジェクト
     * @returns {Promise<ArrayBuffer>} - RVC変換後のWAVデータ (ArrayBuffer)
     */
    async function requestRvcConversion(voicevoxArrayBuffer, currentConfig) {
        // ArrayBufferをBase64 URIに変換するわ
        const base64Audio = arrayBufferToBase64(voicevoxArrayBuffer);
        const inputAudioDataUri = 'data:audio/wav;base64,' + base64Audio;

        // RVC APIのペイロード形式に合わせるわ
        const inputAudioBase64 = {
            name: "voicevox_source.wav",
            data: inputAudioDataUri,
        };

        // URLの末尾のスラッシュを削除し、エンドポイントを結合
        const convertUrl = `${currentConfig.rvcApiUrl.replace(/\/$/, '')}/run/infer_convert`;

        // RVC APIのJSONボディを作成
        const rvcRequestBody = {
            data: [
                currentConfig.rvcNumber,       // 00. 話者ID (0～112) [0]
                null,                          // 01. 元音声のファイルパス（base64で送るのでなし）
                currentConfig.rvcPitch,        // 02. ピッチシフト (-12～12) [12]
                inputAudioBase64,              // 03. 変換元の音声データ（Base64 URI文字列を直接挿入！）
                currentConfig.rvcAlgorithm,    // 04. ピッチ抽出アルゴリズム (pm|harvest|crepe|rmvpe) [rmvpe]
                '',                            // 05. 特徴検索ライブラリへのパス（[6]で指定しているのでなし）（nullはダメ）
                currentConfig.rvcIndex || '',  // 06. インデックスパス [logs\rvcIndex.index]
                currentConfig.rvcRatio,        // 07. 検索特徴率 (0～1) [0.75]
                currentConfig.rvcMedianFilter, // 08. メディアンフィルタ (0～7) [3]
                currentConfig.rvcResample,     // 09. リサンプリング (0～48000) [0]
                currentConfig.rvcEnvelope,     // 10. エンベロープの融合率 (0～1) [0.25]
                currentConfig.rvcArtefact,     // 11. 明確な子音と呼吸音を保護 (0～0.5) [0.33]
            ],
        };

        let xhr;

        try {
            const base64Response = await new Promise((resolve, reject) => {
                xhr = GM_xmlhttpRequest({
                    method: 'POST',
                    url: convertUrl,
                    data: JSON.stringify(rvcRequestBody),
                    headers: { "Content-Type": "application/json", },
                    responseType: 'json',
                    timeout: VOICEVOX_TIMEOUT_MS, // グローバル定数を使用
                    onload: (response) => {
                        // 応答データをコンソールにダンプして確認
                        console.log('[RVC Conversion] RVCサーバーからの応答:', response);

                        // 応答の3番目の要素 (インデックス[2]) から data プロパティを抽出
                        if (response.status === 200 && response.response?.data?.[2]?.data) {
                            resolve(response.response.data[2].data); // Base64 URI文字列を返す
                        } else {
                            // 失敗ステータス: 応答がJSONじゃない場合も考慮して安全にパース
                            const detail = response.response?.detail || response.statusText || 'Unknown Error';
                            reject(`RVC失敗: ${detail}`);
                        }
                    },
                    onerror: () => reject(new Error('RVC接続エラー')),
                    ontimeout: () => reject(new Error('RVCタイムアウト')),
                    onabort: () => reject(new Error('RVC中断')),
                });
                currentXhrs.push(xhr); // XHRリストに追加
                updateButtonState();
            });

            // Base64 URIが正しいかチェック
            if (!base64Response?.startsWith('data:audio/wav;base64,')) {
                throw new Error('不正な音声データ形式よ');
            }

            // --- Base64 URIからArrayBufferへの変換 ---
            const base64 = base64Response.split(',')[1];
            const binary = atob(base64);
            const buffer = new Uint8Array(binary.length);

            // バイナリデータをArrayBufferに書き込む
            for (let i = 0; i < binary.length; i++) {
                buffer[i] = binary.charCodeAt(i);
            }

            return buffer.buffer;

        } finally {
            // 成功しても失敗してもリストから削除
            if (xhr) {
                currentXhrs = currentXhrs.filter(item => item !== xhr);
                updateButtonState();
            }
        }
    }

    /**
     * RVC連携の全処理（VOICEVOX Query/Synthesis + RVC変換）をストリーミングで実行する
     * @param {string} text - 合成するテキスト（getGeminiAnswerText()の結果）
     * @param {Object} currentConfig - 現在の設定オブジェクト
     * @param {boolean} isAutoPlay - 自動再生フラグ
     * @param {string} cacheKey - 生成されたキャッシュキー (ストリーミング中はキャッシュ処理をスキップ)
     */
    async function synthesizeRvcAudio(text, currentConfig, isAutoPlay, cacheKey) {
        if (!currentConfig.rvcEnabled) {
            return;
        } // RVC無効なら即終了（ガード句）

        // 1. 分割
        const MAX_CHUNK_LENGTH = currentConfig.chunkSize || DEFAULT_CHUNK_SIZE;
        let chunks = splitTextForSynthesis(text, MAX_CHUNK_LENGTH);

        // 2. 最大チャンク数制限
        if (chunks.length > currentConfig.maxChunks) {
            chunks = chunks.slice(0, currentConfig.maxChunks);
            chunks.push("。……。指定の分割数を超えたため、読み上げを終了したわ。");
            showToast(`最大チャンク数(${currentConfig.maxChunks})を超えたため、制限をかけたわよ。`, false);
        }

        // 3. トータル
        const totalChunks = chunks.length;

        isConversionAborted = false;

        console.log('[RVC] 音声データを合成準備中... (ストリーミング版)');

        // モデルファイル存在チェック
        if (!currentConfig.rvcModel) {
            showToast('😭 連携失敗: RVC モデルファイル名が設定されてないわ。', false);
            console.error('[RVC Error] RVC Model path is empty.');
            stopPlayback(); // ボタン状態をリセット
            return;
        }
        loadRvcModel(currentConfig); // RVCモデルのロード処理（初回のみ）

        // RVC失敗時のフォールバックを管理するフラグ
        let rvcFailed = false;
        const successfulRvcBlobs = []; // 成功したRVC変換を一時的に格納する配列

        try {
            initStreamingPlayback(isAutoPlay); // ストリーミング再生を初期化
            for (let i = 0; i < totalChunks; i++) {
                const chunk = chunks[i];

                // 合成中断要求チェック
                if (isConversionAborted) {
                    // AudioContextがクローズされた後の合成継続を防ぐわ！
                    console.log('[RVC] 合成中断要求が確認されたわ。ループを終了するわね。');
                    // ループから抜けて、finally処理に進むためにエラーを投げるわ
                    throw new Error('RVC Synthesis Aborted by User Request');
                }

                if (!isPlaying) {
                    showToast(`WAVデータを生成中... （${text.length}文字）[${i + 1}/${totalChunks}]`, null);
                }
                console.log(`[VOICEVOX|RVC] [${getFormattedDateTime()}] WAVデータを生成中... (${i + 1}/${totalChunks})`);

                // --- 1. VOICEVOX Query & Synthesis (Chunk Text -> WAV ArrayBuffer) ---
                let voicevoxArrayBuffer = null;
                try {
                    // VOICEVOX Query
                    const audioQueryUrl = `${currentConfig.apiUrl}/audio_query`;
                    const queryParams = new URLSearchParams({
                        text: chunk,
                        speaker: currentConfig.speakerId,
                    });
                    const audioQuery = await new Promise((resolve, reject) => {
                        const xhr = GM_xmlhttpRequest({
                            method: 'POST',
                            url: `${audioQueryUrl}?${queryParams.toString()}`,
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            timeout: VOICEVOX_TIMEOUT_MS,
                            onload: (response) => {
                                if (response.status === 200) {
                                    resolve(JSON.parse(response.responseText));
                                } else {
                                    reject(`VOICEVOX Query 失敗 (Status: ${response.status})`);
                                }
                            },
                            onerror: () => reject('VOICEVOX Query 接続エラー'),
                            ontimeout: () => reject('VOICEVOX Query タイムアウト'),
                        });
                        currentXhrs.push(xhr);
                    });

                    // VOICEVOX Synthesis
                    const synthesisUrl = `${currentConfig.apiUrl}/synthesis`;
                    const synthesisParams = new URLSearchParams({
                        speaker: currentConfig.speakerId,
                    });
                    voicevoxArrayBuffer = await new Promise((resolve, reject) => {
                        const xhr = GM_xmlhttpRequest({
                            method: 'POST',
                            url: `${synthesisUrl}?${synthesisParams.toString()}`,
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            responseType: 'arraybuffer',
                            data: JSON.stringify(audioQuery),
                            timeout: VOICEVOX_TIMEOUT_MS,
                            onload: (response) => {
                                if (response.status === 200) {
                                    resolve(response.response);
                                } else {
                                    reject(`VOICEVOX Synthesis 失敗 (Status: ${response.status})`);
                                }
                            },
                            onerror: () => reject('VOICEVOX Synthesis 接続エラー'),
                            ontimeout: () => reject('VOICEVOX Synthesis タイムアウト'),
                        });
                        currentXhrs.push(xhr);
                    });

                } catch (error) {
                    // VOICEVOXのQuery/Synthesis失敗は致命的
                    console.error('[VOICEVOX|RVC] VOICEVOX処理中にエラー発生:', error);
                    throw error; // 外側のtry...catchに渡す
                }

                // VOICEVOXのXHRが成功したらリストをクリア
                currentXhrs.length = 0;
                updateButtonState();

                // --- 2. RVC Conversion / Fallback ---
                let audioBlobToPlay = null;   // 再生用Blobを格納する変数をループ内で宣言し直す
                let chunkResultBuffer = null; // 最終的に再生/キャッシュに使うArrayBuffer

                if (currentConfig.rvcEnabled && !rvcFailed) {
                    // RVC変換を試みる
                    try {
                        // `convertRvcAudioToArrayBuffer` を呼び出し、ArrayBufferを取得するわ
                        chunkResultBuffer = await requestRvcConversion(voicevoxArrayBuffer, currentConfig);
                        // ArrayBufferをBlobに変換して再生用変数に格納
                        audioBlobToPlay = new Blob([chunkResultBuffer,], { type: 'audio/wav', });
                    } catch (e) {
                        console.error('[RVC Conversion] RVC変換エラー発生:', e);
                        rvcFailed = true; // RVC失敗フラグ: 以降のチャンクはVOICEVOXのままにする
                        // showToast('😭 RVC変換に失敗！VOICEVOXのオリジナル音声に切り替えるわ。', false);

                        // 失敗したこのチャンクは、VOICEVOXオリジナル音声で再生
                        console.warn('[RVC Fallback] RVC変換に失敗したため、VOICEVOXのオリジナル音声で代替再生を試みます。');
                        audioBlobToPlay = new Blob([voicevoxArrayBuffer,], { type: 'audio/wav', });
                    }
                }

                // RVCがオフ、または失敗した場合はオリジナルを使用
                if (!audioBlobToPlay) {
                    audioBlobToPlay = new Blob([voicevoxArrayBuffer,], { type: 'audio/wav', });
                }

                // RVC変換が成功した場合のみ、キャッシュ用にArrayBufferを保持する
                if (chunkResultBuffer) {
                    successfulRvcBlobs.push(audioBlobToPlay);
                }

                // --- 3. Enqueue Playback ---
                // 再生キューに追加し、再生されるまで待つ
                await enqueueChunkForPlayback(audioBlobToPlay, i + 1, totalChunks, currentConfig, cacheKey, isAutoPlay);
            }

            // --- 4. キャッシュ保存 ---
            if (!rvcFailed && successfulRvcBlobs.length > 0 && cacheKey) {
                const finalBlob = await connectWavBlobs(successfulRvcBlobs);
                await saveCache(cacheKey, finalBlob, 'RVC');
            }
        } catch (error) {
            // VOICEVOXのQueryやSynthesisの時点でエラーが発生した場合
            console.error('[VOICEVOX|RVC] 連携処理中に致命的なエラー発生:', error);
            const errorMessage = (typeof error === 'string') ? error : error.message;
            const shortErrorMessage = errorMessage.replace(/\s*\(Status:.*?\)/g, '');
            showToast(`😭 連携失敗: ${shortErrorMessage}`, false);
            stopPlayback(true); // エラー時は強制停止してボタンをリセットするわ
        }
        // finally ブロックは、enqueueChunkForPlayback の再生キューが空になった時に
        // 最終的な stopPlayback(true) を呼び出すので、ここでは追加で stopPlayback は不要よ。
    }

    // RVCサーバーに現在ロード中のモデルを問い合わせるAPI (infer_loaded_voice) を呼び出すわ
    async function getCurrentLoadedModel(currentConfig) {
        const statusUrl = `${currentConfig.rvcApiUrl.replace(/\/$/, '')}/run/infer_loaded_voice`;

        try {
            // GM_xmlhttpRequest は Promise を返さないので、手動でラップするわ
            const response = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: statusUrl,
                    data: JSON.stringify({
                        data: [],
                    }), // 引数は空でOKだけど、GradioのAPI形式に合わせるわ
                    headers: {
                        "Content-Type": "application/json",
                    },
                    responseType: 'json',
                    timeout: 5000, // 高速なAPIだからタイムアウトは短くて大丈夫よ
                    onload: (res) => resolve(res),
                    onerror: (err) => reject(new Error(err.responseText || 'Connection error')),
                    ontimeout: () => reject(new Error('Timeout while checking RVC status.')),
                });
            });

            // GradioのAPI応答形式: {data: [ {status: 'success', ...} ]} を想定
            if (response.status === 200 && response.response && response.response.data && response.response.data.length > 0) {
                const loadedInfo = response.response.data[0];

                if (loadedInfo && loadedInfo.status === 'success') {
                    const modelName = loadedInfo.model_file_name;
                    // 'Model Not Loaded' という静的な英語を null に変換するわ
                    return (modelName && modelName !== 'Model Not Loaded') ? modelName : null;
                }
            }
        } catch (error) {
            // 接続エラーやAPIエラー時は、安全のためロードを続行する（nullを返す）
            // console.warn('[RVC Check] ⚠️ モデル状態チェックAPIにアクセスできませんでした。エラー:', error.message);
        }
        return null;
    }

    /**
     * RVCモデルとインデックスをサーバーにロードする
     * @param {Object} currentConfig - 現在の設定オブジェクト
     * @returns {Promise<boolean>} - ロードに成功した場合はtrue、失敗した場合はfalse
     */
    async function loadRvcModel(currentConfig) {
        if (!currentConfig.rvcEnabled) {
            return false;
        }

        const requiredModel = currentConfig.rvcModel;

        try {
            console.log(`[RVC Load] [${getFormattedDateTime()}] 🔍 現在ロード中のモデルをチェック中...`);
            const loadedModel = await getCurrentLoadedModel(currentConfig);

            if (loadedModel === requiredModel) {
                // 🚀 ロードをスキップ！
                console.log(`[RVC Load] [${getFormattedDateTime()}] ✅ モデル '${requiredModel}' は既にロードされています。ロードをスキップします。`);
                return true; // 処理完了
            } else if (loadedModel) {
                // 別のモデルがロードされているので、ロード処理（infer_change_voice）に進む
                console.log(`[RVC Load] [${getFormattedDateTime()}] 🔄 別のモデル ('${loadedModel}') がロードされています。'${requiredModel}' に切り替えます...`);
            } else {
                // モデルが何もロードされていないので、ロード処理に進む
                console.log(`[RVC Load] [${getFormattedDateTime()}] 🤖 モデル '${requiredModel}' をロードします...`);
            }
        } catch (e) {
            console.error('[RVC Load] ❌ ロードチェック中に予期せぬエラー。ロードを強制実行します:', e);
            // エラー時はフォールバックとして、そのままロード処理に進ませるわ
        }

        // 1. ロード中なら待機（排他制御）
        while (isRvcModelLoading) {
            // 処理が重ならないように前の処理が終わるまで待つ
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        // 2. ロード開始
        isRvcModelLoading = true;

        const loadUrl = `${currentConfig.rvcApiUrl.replace(/\/$/, '')}/run/infer_change_voice`;

        try {
            const loadPromise = new Promise((resolve, reject) => {
                const rvcRequestBody = {
                    data: [
                        requiredModel,             // 0. RVC モデルファイルパス
                        currentConfig.rvcArtefact, // 1. rvcArtefact
                        currentConfig.rvcArtefact, // 2. rvcArtefact
                    ],
                };

                const xhr = GM_xmlhttpRequest({
                    method: 'POST',
                    url: loadUrl,
                    data: JSON.stringify(rvcRequestBody),
                    headers: {
                        "Content-Type": "application/json",
                    },
                    responseType: 'json',
                    timeout: 30000, // モデルロードなので長めに30秒
                    onload: (response) => {
                        if (response.status === 200) {
                            // console.log(`[RVC Load] ✅ モデル '${requiredModel}' のロードとキャッシュが完了したわ！`, response.response);
                            resolve();
                        } else {
                            reject(`RVCモデルロード失敗 (Status: ${response.status} / Response: ${JSON.stringify(response.response)})`);
                        }
                    },
                    onerror: () => reject('RVCモデルロード 接続エラー'),
                    ontimeout: () => reject('RVCモデルロード タイムアウト (サーバーが応答しないかも)'),
                });
            });

            await loadPromise;
            console.log(`[RVC Load] [${getFormattedDateTime()}] 🤖 モデル '${requiredModel}' のロードが完了しました。`);
            return true;

        } catch (error) {
            const errorMessage = (typeof error === 'string') ? error : (error.message || '不明なエラー');
            const shortErrorMessage = errorMessage.replace(/\s*\(Status:.*?\)/g, '');
            console.error('[RVC Load] ❌ モデルロード中にエラー発生:', error);
            return false;
        } finally {
            isRvcModelLoading = false;
        }
    }

    /**
     * VOICEVOX連携の処理（audio_query -> synthesis -> playAudio）
     * ストリーミング再生（Web Audio API）を優先しつつ、失敗時はBlob結合による一括再生にフォールバックするわ。
     * @param {string} text - 合成するテキスト
     * @param {Object} currentConfig - 現在の設定オブジェクト
     * @param {boolean} isAutoPlay - 自動再生フラグ
     * @param {string} cacheKey - 生成されたキャッシュキー
     */
    async function synthesizeVoicevoxAudio(text, currentConfig, isAutoPlay, cacheKey) {
        // 1. 分割
        const MAX_CHUNK_LENGTH = currentConfig.chunkSize || DEFAULT_CHUNK_SIZE;
        let chunks = splitTextForSynthesis(text, MAX_CHUNK_LENGTH);

        // 2. 最大チャンク数制限
        if (chunks.length > currentConfig.maxChunks) {
            chunks = chunks.slice(0, currentConfig.maxChunks);
            chunks.push("。……。指定の分割数を超えたため、読み上げを終了したわ。");
            showToast(`最大チャンク数(${currentConfig.maxChunks})を超えたため、制限をかけたわよ。`, false);
        }

        // 3. トータル
        const totalChunks = chunks.length;

        isConversionAborted = false;

        if (totalChunks === 0) {
            showToast('合成する有効なテキストがないわ。', false);
            return;
        }

        const apiUrl = currentConfig.apiUrl;
        const speakerId = currentConfig.speakerId;

        // フォールバックのために、合成された音声Blobを格納する配列を復活させるわ！
        const audioBlobs = [];

        try {
            // ストリーミング再生を初期化するわ。失敗した場合でも続行するわよ！
            initStreamingPlayback(isAutoPlay);

            for (let i = 0; i < totalChunks; i++) {
                const chunk = chunks[i];

                // 合成中断要求チェック
                if (isConversionAborted) {
                    // AudioContextがクローズされた後の合成継続を防ぐわ！
                    console.log('[SYNTH] 合成中断要求が確認されたわ。ループを終了するわね。');
                    // ループから抜けて、finally処理に進むためにエラーを投げるわ
                    throw new Error('Synthesis Aborted by User Request');
                }

                // 進捗状況を更新
                if (!isPlaying) {
                    showToast(`WAVデータを生成中... （${text.length}文字）[${i + 1}/${totalChunks}]`, null);
                }
                console.log(`[VOICEVOX|RVC] [${getFormattedDateTime()}] WAVデータを生成中... (${i + 1}/${totalChunks})`);

                // --- 1. audio_query (Text -> Query JSON) ---
                const audioQuery = await new Promise((resolve, reject) => {
                    const queryParams = new URLSearchParams({
                        text: chunk,
                        speaker: speakerId,
                    });
                    const audioQueryUrl = `${apiUrl}/audio_query?${queryParams.toString()}`;

                    const xhr = GM_xmlhttpRequest({
                        method: 'POST',
                        url: audioQueryUrl,
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        timeout: VOICEVOX_TIMEOUT_MS, // タイムアウト設定
                        onload: (response) => {
                            currentXhrs = currentXhrs.filter(item => item !== xhr); // 完了したら削除！
                            if (response.status === 200) {
                                resolve(JSON.parse(response.responseText));
                            } else {
                                reject(`VOICEVOX Query 失敗 (Status: ${response.status}) (${i + 1}/${totalChunks})`);
                            }
                        },
                        onerror: () => {
                            currentXhrs = currentXhrs.filter(item => item !== xhr); // エラーでも削除！
                            reject(`VOICEVOX Query 接続エラー (${i + 1}/${totalChunks})`);
                        },
                        ontimeout: () => {
                            currentXhrs = currentXhrs.filter(item => item !== xhr); // タイムアウトでも削除！
                            reject(`VOICEVOX Query タイムアウト (${i + 1}/${totalChunks})`);
                        },
                    });
                    currentXhrs.push(xhr);
                });

                audioQuery.speedScale      = currentConfig.speedScale      ?? 1.0;
                audioQuery.pitchScale      = currentConfig.pitchScale      ?? 0.0;
                audioQuery.intonationScale = currentConfig.intonationScale ?? 1.0;
                audioQuery.volumeScale     = currentConfig.volumeScale     ?? 1.0;

                // --- 2. synthesis (Query JSON -> WAV Blob) ---
                const chunkBlob = await new Promise((resolve, reject) => {
                    const synthesizeUrl = `${apiUrl}/synthesis?speaker=${speakerId}`;

                    const xhr = GM_xmlhttpRequest({ // XHRをローカル変数で受け取る
                        method: 'POST',
                        url: synthesizeUrl,
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        data: JSON.stringify(audioQuery),
                        responseType: 'blob',
                        timeout: VOICEVOX_TIMEOUT_MS, // タイムアウト設定
                        onload: (response) => {
                            currentXhrs = currentXhrs.filter(item => item !== xhr); // 完了したら配列から削除！
                            if (response.status === 200 && response.response) {
                                resolve(response.response);
                            } else {
                                // 500エラーが来たら、メモリ不足の可能性が非常に高いわ！
                                reject(`VOICEVOX Synthesis 失敗 (Status: ${response.status}) (${i + 1}/${totalChunks})`);
                            }
                        },
                        onerror: () => {
                            currentXhrs = currentXhrs.filter(item => item !== xhr); // エラーでも削除！
                            reject(`VOICEVOX Synthesis 接続エラー (${i + 1}/${totalChunks})`);
                        },
                        ontimeout: () => {
                            currentXhrs = currentXhrs.filter(item => item !== xhr); // タイムアウトでも削除！
                            reject(`VOICEVOX Synthesis タイムアウト (${i + 1}/${totalChunks})`);
                        },
                    });
                    currentXhrs.push(xhr); // 実行直後に配列に追加！
                });

                // 実行が完了したQuery XHRをここでまとめて削除するわ（Synthesis開始前に削除するのが理想だけど、安全性重視で）
                currentXhrs.length = 0;
                updateButtonState();

                // 【二重処理！】Blobを両方のロジックで使うわ！
                audioBlobs.push(chunkBlob); // 1. フォールバック/キャッシュ用に保持

                // ストリーミング再生のキューに送るわ！
                await enqueueChunkForPlayback(chunkBlob, i + 1, totalChunks, currentConfig, cacheKey, isAutoPlay);
            }

            // --- 3. 結合・キャッシュ保存・Playback（フォールバックとキャッシング） ---
            const finalAudioBlob = await connectWavBlobs(audioBlobs); // 結合処理

            if (cacheKey) {
                await saveCache(cacheKey, finalAudioBlob, 'VOICEVOX');
            }

            // ストリーミング再生ができない、または失敗した場合のフォールバック処理！
            if (!audioContext || !isPlaying) { // isPlayingがfalseなら、ストリーミングが中断された可能性があるわ
                // AudioContextが使えない、または途中でエラーになった場合（フォールバック！）
                showToast('😭 ストリーミング再生に失敗したわ... 全体の結合を開始するわね！', false);
                console.log('[Fallback] ストリーミング失敗。Blob結合に切り替えるわ。');
                // Playback
                const successMessage = isAutoPlay ? '🔊 WAVデータの取得に成功したわ！音声再生中よ！' : '✅ 音声データの準備完了！再生ボタンを押してね。';
                await playAudio(finalAudioBlob, 0, successMessage);
            }
        } catch (error) {
            if (error.message?.includes('Aborted')) {
                console.log('[SYNTH] ユーザーによる中断を正常に処理したわ。');

                const errorMessage = (typeof error === 'string') ? error : error.message;
                const isInternalError = errorMessage.includes('Status: 500');
                let shortErrorMessage = errorMessage.replace(/\s*\(Status:.*?\)/g, '');
                if (isInternalError) {
                    shortErrorMessage = `致命的エラー (500)！メモリ不足の可能性あり。長文合成のチャンクサイズを${DEFAULT_CHUNK_SIZE}文字以下に調整してみて！`;
                }
                showToast(`😭 連携失敗: ${shortErrorMessage}`, false);

                await stopPlayback(true);
            } else {
                throw error; // startConversion の catch に渡す
            }
        }
    }

    /**
     * 長文をVOICEVOXの制約に合わせ、句読点を考慮して分割するわ！
     * @param {string} text - 分割前のテキスト
     * @param {number} maxChunkLength - チャンクの最大文字数（例: 300）
     * @returns {string[]} - 分割されたテキストの配列
     */
    function splitTextForSynthesis(text, maxChunkLength) {
        // 1. 分割文字 [\n。？！、,.?!；;：:]  <- 日本語の句読点 ＋ 英語の句読点 ＋ セミコロン・コロン
        // \s*: 空白文字が0回以上続くことを許可（行頭の空白などに対応）
        // 正規表現で分割すると、区切り文字が消えるから、区切り文字も一緒にキャプチャするわ！
        const segments = text.split(/(\s*[\n。？！、,.?!；;：:])/);

        let chunks = [];
        let currentChunk = "";

        // 2. 分割されたピースを結合し、文字数制限をかけるわ。
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            if (!segment || segment.trim() === "") {
                continue;
            }

            // 次のセグメントを結合すると最大長を超えるかチェック
            // ただし、currentChunkが空の場合は、そのセグメント自体が長すぎるかチェック
            if (currentChunk.length + segment.length > maxChunkLength && currentChunk.length > 0) {
                // 現在のチャンクを確定して新しいチャンクを開始
                chunks.push(currentChunk.trim());
                currentChunk = segment;
            } else {
                // 結合するか、新しいチャンクとして開始
                currentChunk += segment;
            }
        }

        // 3. 最後に残ったチャンクを追加
        if (currentChunk.length > 0) {
            chunks.push(currentChunk.trim());
        }

        // 最終的に、maxChunkLengthを超えるチャンクはここで強制分割が必要になるけど
        // まずはこの「句読点優先ロジック」で試してみて、極端な長文ピースがなければOKよ！
        return chunks;
    }

    /**
     * 結合された音声データ(Blob)をBase64に変換し、Tampermonkeyのストレージにキャッシュとして保存するわ。
     * VOICEVOXとRVCの両方から呼び出せるようにするわ。
     * @param {string} cacheKey - キャッシュのキーとして使うハッシュ値
     * @param {Blob} finalBlob - 結合された最終的なWAV音声データ (Blob)
     * @param {string} source - キャッシュ元 ('VOICEVOX' または 'RVC')
     */
    async function saveCache(cacheKey, finalBlob, source) {
        // BlobをData URL (Base64) に変換するわ（VOICEVOX側で使っていた処理をそのまま使うわ）
        const base64WavData = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = function() {
                // Data URL (例: data:audio/wav;base64,...) を返すわ
                resolve(reader.result);
            };
            reader.onerror = reject;
            reader.readAsDataURL(finalBlob);
        });

        // キャッシュを保存！
        GM_setValue(LAST_CACHE_HASH, cacheKey);
        GM_setValue(LAST_CACHE_DATA, base64WavData);

        console.log(`[Cache] 💾 ${source}音声をキャッシュに保存したわ！ (Key: ${cacheKey.substring(0, 50)}...)`);
    }

    // キャッシュキーを生成する関数
    function generateCacheKey(text, config) {
        // VVとRVCで共通の必須キー（textとspeakerIdが同じなら、VOICEVOXの素の音声は同じになる）
        const keyParts = [
            text,
            config.speakerId,
            config.rvcEnabled ? 'RVC' : 'VV', // VVかRVCかを識別
        ];

        // 共通のVOICEVOXパラメーターをキーに追加
        // （configにVOICEVOXの音量, 速度, ピッチ調整UIが将来追加されることを想定）
        // 現在はUIがないため、デフォルト値（未設定）が使われるが、将来対応のための布石。
        keyParts.push(
            config.speedScale || 1.0,      // 速度
            config.pitchScale || 0.0,      // ピッチ
            config.intonationScale || 1.0, // 抑揚
            config.volumeScale || 1.0      // 音量
        );

        // RVCが有効な場合のみ、RVCの全設定パラメータをキーに追加
        if (config.rvcEnabled) {
            // ... (RVCの全パラメータを push するロジックは省略せずに継続) ...
            keyParts.push(
                config.rvcModel || '',
                config.rvcIndex || '',
                config.rvcPitch || 0,
                config.rvcRatio || 0.75,
                config.rvcAlgorithm || 'rmvpe',
                config.rvcResample || 48000,
                config.rvcNumber || 0,
                config.rvcEnvelope || 0.25,
                config.rvcArtefact || 0.33,
                config.rvcMedianFilter || 3
            );
        }

        // JSON文字列化、Base64エンコードしてキーとして返す
        const hash = JSON.stringify(keyParts);
        const encodedHash = encodeURIComponent(hash);
        return 'audio_cache_' + btoa(encodedHash).replace(/=+$/, '');
    }

    /*
     * キャッシュされたBase64データを再生する関数
     * Blob変換ロジックを再利用し、新しいplayAudioに処理を移譲するわ。
     * 成功時に true、失敗時に false を返す
     */
    async function playCachedAudio(base64WavData) {
        stopPlayback(true);

        try {
            // Base64 URIからBlobオブジェクトを生成する
            const cachedBlob = base64UriToBlob(base64WavData, 'audio/wav');
            // playAudioに渡すメッセージを設定（自動再生ブロック時はplayAudio内で別のメッセージに変わる）
            const successMessage = '🔊 キャッシュから再生するよ♪';
            // 新しい playAudio 関数を呼び出す！
            await playAudio(cachedBlob, 0, successMessage);
            return true;
        } catch (e) {
            // Blob生成でエラーが発生した場合（キャッシュデータが壊れている）
            GM_deleteValue(LAST_CACHE_HASH);
            GM_deleteValue(LAST_CACHE_DATA);
            console.error('[Cache Playback] Blob生成エラー:壊れたキャッシュデータを削除し、状態をリセットしました。再合成を試みます。', e);
            stopPlayback(true); // エラー時は状態をリセット
            return false;
        }
    }

    // メインの再生のトリガー
    async function startConversion(isAutoPlay = false) {
        const currentConfig = GM_getValue(STORE_KEY, config);

        // 物理的な「実態」をチェックするわよ
        const isAuto = (isAutoPlay === true);

        if (DEBUG) {
            console.log(`[Debug] Mode:${isAuto ? 'AUTO' : 'MANUAL'}, Synth:${isConversionStarting}, Play:${isPlaying}, Audio:${audioContext?.state}`);
        }

        if (isAuto) {
            if (DEBUG) {
                console.log('[Debug] 自動再生の割り込み。強制的に全停止して更地にするわよ。');
            }

            // ループ中断フラグを即座に立てる（重要：awaitの前に立てる！）
            isConversionAborted = true;
            // 前の再生や合成を完全に止める（awaitで完了を待つ）
            await stopPlayback(true);

            // 完全に掃除が終わってからフラグリセット
            isConversionAborted = false;
        } else {
            // 手動時：Synth か Play が本当のビジー状態
            if (isConversionStarting || isPlaying) {
                showToast('今は再生中よ。停止ボタンで止めてから次の操作をしてね。', false);
                return;
            }
            // AudioContext が残っているだけなら、ここで掃除を試みる
            if (audioContext && audioContext.state !== 'closed') {
                console.log('[Debug] 古い AudioContext を掃除して開始するわ。');
                await stopPlayback(true);
            }
        }

        // 一時停止
        if (isPause) {
            isPause = false;
            if (audioContext && audioContext.state === 'suspended') {
                audioContext.resume();
            }
            return;
        }

        console.log(`[VOICEVOX|RVC] [${getFormattedDateTime()}] Geminiの回答を取得中...`);
        let text = getGeminiAnswerText();
        if (!text || text.trim() === '') {
            showToast('回答テキストが取得できなかったか、全て除去されたわ...', false);
            return;
        }

        if (isAutoPlay) {
            lastAutoPlayedText = text; // 自動再生の場合、次回以降の自動再生を抑止
        }

        console.log(`[SYNTH] 読み上げテキスト（${text.length}文字）: ${text.substring(0, 50)}...`);

        // キャッシュチェック
        const requestCacheKey = generateCacheKey(text, currentConfig);
        const cachedHash = GM_getValue(LAST_CACHE_HASH, null);

        if (requestCacheKey === cachedHash) {
            const cachedData = GM_getValue(LAST_CACHE_DATA, null); // Base64 URI
            if (cachedData) {
                console.log(`[Cache] ✅ キャッシュヒット！即時再生を試みます！`);
                const success = await playCachedAudio(cachedData); // キャッシュ再生関数を呼び出す
                if (success) {
                    return; // 成功したらここで終了よ
                }
            }
        }

        isConversionStarting = true; // 「合成中」開始フラグ
        updateButtonState();

        try {
            if (currentConfig.rvcEnabled) {
                await synthesizeRvcAudio(text, currentConfig, isAutoPlay, requestCacheKey);
            } else {
                await synthesizeVoicevoxAudio(text, currentConfig, isAutoPlay, requestCacheKey);
            }
        } catch (error) {
            // RVC/VOICEVOXの内部処理でハンドルされなかった、予期せぬ致命的なエラーをキャッチ
            // console.error('[SYNTHESIS_FATAL_ERROR] 予期せぬ合成処理エラー:', error);
            // const shortMessage = (typeof error === 'string') ? error : (error.message || '不明なエラー');
            // showToast(`😭 致命的な合成エラー: ${shortMessage.substring(0, 30)}...`, false);
            await stopPlayback(true); // XHRを確実に中止して状態をリセットするわ！
        } finally {
            isConversionStarting = false; // 処理終了時（成功・失敗問わず）にフラグをリセット
            isConversionAborted = false;
            updateButtonState();
        }
    }

    /**
     * ストリーミング再生を開始するための初期設定を行うわ。
     * @param {boolean} isAutoPlay - 自動再生フラグ
     */
    function initStreamingPlayback(isAutoPlay) {
        // Web Audio APIのコンテキストを作成・再利用するわ。
        if (!audioContext) {
            // NOTE: ブラウザによってWebkitを使う場合があるわ
            audioContext = new(window.AudioContext || window.webkitAudioContext)();
        }

        // 状態をリセットするわ。
        nextStartTime = 0;
        totalStreamingChunks = 0;
        finishedStreamingChunks = 0;
        currentStreamingCacheKey = null;

        // AudioContextが動いているか確認するわ。（一時停止中の場合もあるわ）
        if (audioContext && audioContext.state === 'suspended') {
            // ユーザーの操作待ちなら、再開を試みるわ。
            audioContext.resume().catch(e => console.warn('[Streaming] 📢 AudioContextの再開に失敗したわ:', e));
        }

        // 音声が再生されることをユーザーに知らせるわ！
        if (isAutoPlay && audioContext) { // AudioContextが使えそうなら期待させるわ
            // showToast('WAVデータの合成が完了次第、ストリーミング再生を開始するわ！', true);
        } else if (isAutoPlay) {
            // AudioContextが使えない場合は、フォールバック（結合再生）に期待するわ
            // showToast('ストリーミング再生は難しいみたい。WAV結合後に再生するわね！', true);
        }
    }

    /**
     * 合成された音声チャンク（Blob）をRVC変換し、Web Audio APIのキューに追加し、再生するわ。
     * @param {Blob} chunkBlob - 合成された音声のBlobデータ（VOICEVOXオリジナル）
     * @param {number} chunkIndex - 現在のチャンクのインデックス（1始まり）
     * @param {number} totalChunks - 全体のチャンク数
     * @param {Object} currentConfig - 現在の設定オブジェクト
     * @param {string} cacheKey - キャッシュキーのベース
     * @param {boolean} isAutoPlay - 自動再生フラグ
     */
    async function enqueueChunkForPlayback(playableBlob, chunkIndex, totalChunks, currentConfig, cacheKey, isAutoPlay) {
        // AudioContextが使えないなら何もしないわ（フォールバックに任せるわよ！）
        if (!audioContext || audioContext.state === 'closed' || isConversionAborted) {
            return;
        }

        // Autoplay Policy 解除のための resume() 処理を追加！
        if (audioContext.state === 'suspended') {
            // 【重要】await を外し、ブロックさせずに処理を続行するわ！
            audioContext.resume().catch(e => {
                // 再開に失敗したらログだけ出すわ
                console.error("[AudioContext] ❌ resumeに失敗:", e);
                // ここで catch されたとしても、AudioContext の状態は変わらないわ。
            });
        }

        // トータルチャンク数を記録するわ！
        totalStreamingChunks = totalChunks;

        try {
            // BlobをArrayBufferに変換するわ
            const arrayBuffer = await playableBlob.arrayBuffer();

            // ArrayBufferをAudioBufferにデコードするわ（非同期処理）
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

            // 再生ノードを作成し、キューに追加するわ
            const source = audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioContext.destination);

            // 再生開始時刻を計算し、キューに追加するわ
            // nextStartTimeが初期値(0)か、AudioContextの現在時刻より過去なら、現在の時刻から再生を開始するわ！
            if (chunkIndex === 1 || nextStartTime < audioContext.currentTime) {
                nextStartTime = audioContext.currentTime;
            }

            // 最初のチャンクが再生される直前に、状態を「再生中」にする
            if (!isPlaying && audioContext.state === 'running') {
                showToast('🔊 素敵な声で再生スタートよ！', true);
                isPlaying = true;
                updateButtonState(); // ボタンを「停止」に切り替えるわ！
            } else if (audioContext.state !== 'running') {
                isPause = true;
                showToast(`✋🏻 自動再生ブロック。再生ボタンを手動で押してね！`, false);
                updateButtonState();
            }

            // 再生開始時刻を設定し、再生！
            source.start(nextStartTime);
            currentSourceNode = source; // 停止処理のために記録しておくわ

            // 次のチャンクの開始時刻を更新するわ。
            nextStartTime += audioBuffer.duration;

            console.log(`[Streaming] 🔊 チャンク ${chunkIndex}/${totalChunks} を ${nextStartTime.toFixed(2)}秒後にキューイングしたわ。`);

            // 再生が終了したらメモリを解放するコールバックを設定するわ！
            source.onended = () => {
                source.disconnect();
                finishedStreamingChunks++; // 再生完了チャンク数を増やすわ

                // 全てのチャンクの再生が終わったら、ボタンをリセットするわ！
                if (finishedStreamingChunks === totalStreamingChunks) {
                    isPlaying = false;
                    updateButtonState(); // ボタンを最終状態（合成完了後なら「再生」）に戻すわ！
                }
            };
        } catch (e) {
            console.error('[Streaming] ❌ チャンク処理失敗:', e);
            // デコード失敗は致命的だけど、合成自体は続行させるわ。
            showToast(`😭 チャンク ${chunkIndex}/${totalChunks} の処理に失敗したわ。`, false);
            // ... チャンクが失敗した場合の処理（ここではスキップとして扱うわ）
            finishedStreamingChunks++;
            if (finishedStreamingChunks === totalStreamingChunks) {
                isPlaying = false;
                updateButtonState();
            }
        }
    }

    /**
     * 複数のWAV Blobを一つに結合するわ。
     * WAVファイルのヘッダーを解析し、データ部分を連結し、最終的なヘッダーサイズを再計算するの！
     * @param {Blob[]} blobs - 結合するWAV Blobの配列
     * @returns {Promise<Blob>} - 結合された単一のWAV Blob
     */
    async function connectWavBlobs(blobs) {
        if (!blobs || blobs.length === 0) {
            return new Blob([]);
        }
        if (blobs.length === 1) {
            return blobs[0];
        }

        // 全てのBlobをArrayBufferに変換
        const buffers = await Promise.all(blobs.map(blob => blob.arrayBuffer()));

        const firstBuffer = buffers[0];
        const dataView = new DataView(firstBuffer);

        // RIFFヘッダーから'data'チャンクの開始位置を特定
        let dataOffset = -1;
        let offset = 12; // サブチャンクは12バイト目から始まる
        while (offset < firstBuffer.byteLength) {
            const chunkId = dataView.getUint32(offset, false);
            const chunkSize = dataView.getUint32(offset + 4, true);

            if (chunkId === 0x64617461) { // 'data' chunk ID
                dataOffset = offset + 8;
                break;
            }

            offset += 8 + chunkSize + (chunkSize % 2);
        }

        if (dataOffset === -1) {
            throw new Error("WAVデータチャンクが検出できないわ。結合できない！");
        }

        // 全てのdataチャンクを結合
        let totalDataSize = 0;
        const dataChunks = [];

        for (const buffer of buffers) {
            const dv = new DataView(buffer);
            let currentOffset = 12;

            while (currentOffset < buffer.byteLength) {
                const chunkId = dv.getUint32(currentOffset, false);
                const chunkSize = dv.getUint32(currentOffset + 4, true);

                if (chunkId === 0x64617461) { // 'data' chunk ID
                    dataChunks.push(buffer.slice(currentOffset + 8, currentOffset + 8 + chunkSize));
                    totalDataSize += chunkSize;
                    break;
                }

                currentOffset += 8 + chunkSize + (chunkSize % 2);
            }
        }

        // 新しいバッファを作成し、ヘッダーと結合データを入れる
        const headerBeforeData = firstBuffer.slice(0, dataOffset);
        const finalBuffer = new ArrayBuffer(headerBeforeData.byteLength + totalDataSize);
        const finalView = new DataView(finalBuffer);

        // ヘッダー部をコピー
        new Uint8Array(finalBuffer).set(new Uint8Array(headerBeforeData));

        // RIFFチャンクサイズを更新（全体サイズ - 8バイト）
        const newRiffSize = headerBeforeData.byteLength + totalDataSize - 8;
        finalView.setUint32(4, newRiffSize, true);

        // 'data'チャンクサイズを更新
        finalView.setUint32(dataOffset - 4, totalDataSize, true);

        // 結合データ部分をコピー
        let finalDataOffset = headerBeforeData.byteLength;
        for (const dataChunk of dataChunks) {
            new Uint8Array(finalBuffer).set(new Uint8Array(dataChunk), finalDataOffset);
            finalDataOffset += dataChunk.byteLength;
        }

        return new Blob([finalBuffer,], {
            type: 'audio/wav',
        });
    }

    /**
     * WAV/MP3データを再生するわ。自動再生ポリシーに引っかかった場合、最大3回まで再試行するわよ！
     * @param {Blob} blob - 再生する音声データのBlobオブジェクト
     * @param {number} retryCount - 現在のリトライ回数（内部処理用。通常は0で呼び出す）
     */
    async function playAudio(blob, retryCount = 0, successMessage) {
        const RETRY_DELAY_MS = 300; // リトライ間隔は300ms
        if (retryCount > 0) {
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
        // 初回呼び出し時に古い再生を停止する
        if (retryCount === 0) {
            stopPlayback(true);
        }

        const audioUrl = URL.createObjectURL(blob);
        currentAudio = new Audio(audioUrl);

        // 再生終了時の処理（Promiseでラップして await で待機するわ）
        const audioEndedPromise = new Promise(resolve => {
            const audioEndedListener = () => {
                currentAudio.removeEventListener('ended', audioEndedListener);
                resolve('ended');
            };
            currentAudio.addEventListener('ended', audioEndedListener);
        });

        // フラグとボタンの状態を更新（再生開始時のみ）
        if (retryCount === 0) {
            isPlaying = true;
            updateButtonState();
        }

        try {
            await currentAudio.play();

            // 再生成功！
            console.log(`[VOICEVOX|RVC] [${getFormattedDateTime()}] 再生に成功したわ！`);
            if (retryCount > 0) {
                showToast('🎉 再生に成功したわ！', true);
            } else {
                showToast(successMessage, true); // 初回成功時は引数のメッセージ
            }

            // 再生終了を待つ
            await audioEndedPromise;

        } catch (error) {
            // 再生失敗時 (NotAllowedError: play() failed)
            console.error('[VOICEVOX] 音声再生に失敗したわ:', error);

            // リトライ回数を確認
            if (retryCount < MAX_RETRY_COUNT) {
                // まだリトライ可能
                const nextRetryCount = retryCount + 1;
                showToast(`❌ 再生失敗... リトライするわ！ (${nextRetryCount}/${MAX_RETRY_COUNT})`, false);

                // Audioオブジェクトのクリーンアップ（重要！）
                URL.revokeObjectURL(audioUrl);
                currentAudio = null;
                return playAudio(blob, nextRetryCount, '');
            } else {
                // 最大リトライ回数を超えた
                console.error('[VOICEVOX] 最大リトライ回数を超えたから、再生を諦めるわ。');
                showToast(`✋🏻 自動再生ブロック。再生ボタンを手動で押してね！`, false);
                isConversionStarting = false;
            }
        } finally {
            // 再生が成功して終わった、またはリトライ失敗で終わった場合に実行
            // イベントリスナーとオブジェクトをクリーンアップ
            URL.revokeObjectURL(audioUrl); // メモリ解放

            // 状態をリセット
            isPlaying = false;
            updateButtonState();
            currentAudio = null;
        }
    }

    function resumeContext() {
        audioContext.resume();
        isPause = false;
        isPlaying = true;
        updateButtonState();
        showToast('🔊 再生開始！素敵な声が聞こえてくるわ！', true);
    }

    /**
     * 再生中の全てのアクションを停止するわ。（合成の中止を含む）
     * @param {boolean} [silent=false] - trueの場合、停止トーストを表示しないわ。
     */
    async function stopPlayback(silent = false) {
        // 1. 引数の正規化（イベントオブジェクト対策）
        if (typeof silent === 'object' && silent !== null) {
            silent = false;
        }

        // 現在の状態を判定
        const isCurrentlyConverting = isConversionStarting || (currentXhrs.length > 0);

        // 2. 合成中の場合のみ必要なフラグ立て
        if (isCurrentlyConverting) {
            isConversionAborted = true;
        }

        // 3. 共通のリセット処理（XHR中断やHTML Audio停止、ボタン状態リセットなど）
        // resetOperationの中で isPlaying のリセットなども行われる前提
        resetOperation(!silent);

        // 4. AudioContext のクローズ処理（共通化してスッキリ！）
        if (audioContext && audioContext.state !== 'closed') {
            try {
                // ここで await して確実にクローズを待つ
                await audioContext.close();
                console.log(`[Streaming] AudioContext を正常にクローズしたわ。${silent ? '（silent）' : ''}`);
            } catch (e) {
                console.error('[Streaming] AudioContext クローズ失敗:', e);
            } finally {
                // 成功しても失敗しても、変数は必ず掃除するわ！
                audioContext = null;
                currentSourceNode = null;
                nextStartTime = 0;
                finishedStreamingChunks = 0;
                totalStreamingChunks = 0;
                currentStreamingCacheKey = null;
            }
        }
    }

    // 再生ボタンの状態を更新するわ！
    function updateButtonState() {
        const button = document.getElementById('convertButton');
        if (!button) {
            return;
        }
        const icon = document.getElementById('convertButtonIcon');
        const text = document.getElementById('convertButtonText');
        if (!icon || !text) {
            return;
        }

        // 現在の状態を保存しておき、不要な DOM 操作を避ける
        const currentText = text.textContent.trim();
        const currentBg = button.style.backgroundColor;

        button.removeEventListener('click', stopPlayback);
        button.removeEventListener('click', resumeContext);
        button.removeEventListener('click', stopConversion);
        button.removeEventListener('click', startConversion);

        // --- 状態ごとの設定 ---
        if (isPlaying) {
            if (currentText !== '停止') {
                icon.className = 'fa-solid fa-comment-slash';
                text.textContent = ' 停止';
                button.style.backgroundColor = '#dc3545';
            }
            button.addEventListener('click', stopPlayback);
            if (DEBUG_BUTTON) {
                console.log(`[Debug] [${getFormattedDateTime()}] 停止`);
            }
        } else if (isPause && audioContext) {
            if (currentText !== '待機中...') {
                icon.className = 'fa-solid fa-paw';
                text.textContent = ' 待機中...';
                button.style.backgroundColor = '#e67e22';
            }
            button.addEventListener('click', resumeContext);
            if (DEBUG_BUTTON) {
                console.log(`[Debug] [${getFormattedDateTime()}] 待機中`);
            }
        } else if (isConversionStarting || currentXhrs.length > 0) {
            if (currentText !== '合成中...') {
                icon.className = 'fa-solid fa-sync-alt fa-arrows-spin';
                text.textContent = ' 合成中...';
                button.style.backgroundColor = '#6c757d';
            }
            button.addEventListener('click', stopConversion);
            if (DEBUG_BUTTON) {
                console.log(`[Debug] [${getFormattedDateTime()}] 合成中`);
            }
        } else {
            if (currentText !== '再生') {
                icon.className = 'fa-solid fa-comment-dots';
                text.textContent = ' 再生';
                button.style.backgroundColor = '#007bff';
            }
            button.addEventListener('click', startConversion);
            if (DEBUG_BUTTON) {
                console.log(`[Debug] [${getFormattedDateTime()}] 再生`);
            }
        }

        const dlButton = document.getElementById('downloadButton');
        if (dlButton) {
            const cachedData = GM_getValue(LAST_CACHE_DATA, null);

            // --- 追加：現在の画面上のテキストを取得 ---
            const currentGeminiText = getGeminiAnswerText();

            // キャッシュが存在＆Geminiの回答と一致
            const isMatch = cachedData && (currentGeminiText === cachedData.text);

            const shouldBeDisabled = !isMatch; // 一致しないなら無効（グレー）

            if (dlButton.disabled !== shouldBeDisabled) {
                dlButton.disabled = shouldBeDisabled;
            }

            if (isMatch) {
                dlButton.style.backgroundColor = '#007bff'; // 有効な色
            } else {
                // 無効にする場合（GM_addStyleのdisabledセレクタに任せる
                dlButton.style.backgroundColor = '';
            }
        }
    }

    // ボタンを追加するDOM操作の初期化処理
    function addConvertButton() {
        const buttonId = 'convertButton';
        const dlButtonId = 'downloadButton';
        const wrapperId = 'convertButtonWrapper';
        let button = document.getElementById(buttonId);
        let wrapper = document.getElementById(wrapperId);
        let lastAnswerPanel = null;
        let footerSelector = null;

        for (const selector of SELECTORS_RESPONSE) {
            const containers = document.querySelectorAll(selector.container);
            if (containers.length > 0) {
                lastAnswerPanel = containers[containers.length - 1];
                footerSelector = selector.footer;
                break;
            }
        }
        if (!lastAnswerPanel || !footerSelector) {
            return;
        }

        let lastButton = null;
        const allButtons = lastAnswerPanel.querySelectorAll(footerSelector + ':not(#' + buttonId + '):not(#' + dlButtonId + ')');
        lastButton = allButtons[allButtons.length - 1];
        if (!lastButton) {
            return;
        }

        // 最適化ロジック（不要な場合に再配置と再作成をスキップ）
        if (button && wrapper && lastButton.nextElementSibling === wrapper) {
            // ラッパーが正しい位置にあるため、DOM操作をスキップして状態更新へ
            let iconSpan = document.getElementById('convertButtonIcon');
            let textSpan = document.getElementById('convertButtonText');

            if (!iconSpan || !textSpan) {
                // アイコン/テキストがない場合、再作成（このパスに入る可能性は低いが安全策）
                button.textContent = '';
                iconSpan = document.createElement('span');
                iconSpan.id = 'convertButtonIcon';
                textSpan = document.createElement('span');
                textSpan.id = 'convertButtonText';
                button.appendChild(iconSpan);
                button.appendChild(textSpan);
                resetOperation();
            } else {
                updateButtonState();
            }
            return;
        }

        if (lastButton) {
            if (wrapper && lastButton.nextElementSibling !== wrapper) {
                wrapper.remove();
                wrapper = null;
            }
            if (!wrapper) {
                // ラッパーを作成（Flex Itemとして機能させるため）
                wrapper = document.createElement('div');
                wrapper.id = wrapperId;

                // 再生ボタンの作成
                button = document.createElement('button');
                button.id = buttonId;
                // v3.5のカスタムCSSを適用
                button.style.cssText = 'padding: 2px 4px; background-color: #007bff; color: white; border: none; cursor: pointer; margin-left: 4px; border-radius: 16px; hover:scale-105';
                wrapper.appendChild(button);

                // ダウンロードボタンの作成
                const currentConfig = GM_getValue(STORE_KEY, DEFAULT_CONFIG);
                if (currentConfig.dlBtnEnabled) {
                    let dlButton = document.createElement('button');
                    dlButton.id = dlButtonId;
                    dlButton.disabled = true;

                    // ダウンロードボタンのスタイル設定
                    dlButton.style.cssText = `
                        padding: 2px 4px;
                        background-color: #007bff;
                        color: white;
                        border: none;
                        cursor: pointer;
                        margin-left: 8px;
                        width: 28px; /* 丸くするために固定サイズ */
                        height: 28px;
                        border-radius: 50%; /* 丸くする */
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    `;

                    // アイコンを追加
                    const dlIconSpan = document.createElement('span');
                    dlIconSpan.className = 'fa-solid fa-download';
                    dlIconSpan.id = 'downloadButtonIcon';
                    dlButton.appendChild(dlIconSpan);

                    // イベントリスナーを追加
                    dlButton.addEventListener('click', startVoiceDownload);
                    wrapper.appendChild(dlButton);
                }
            } else {
                button = document.getElementById(buttonId);
                if (!button) {
                    return;
                }
            }

            let iconSpan = document.getElementById('convertButtonIcon');
            let textSpan = document.getElementById('convertButtonText');

            if (!iconSpan || !textSpan) {
                button.textContent = '';

                iconSpan = document.createElement('span');
                iconSpan.id = 'convertButtonIcon';
                textSpan = document.createElement('span');
                textSpan.id = 'convertButtonText';

                button.appendChild(iconSpan);
                button.appendChild(textSpan);

                resetOperation();
            } else {
                updateButtonState();
            }

            lastButton.insertAdjacentElement('afterend', wrapper);
        } else {
            console.log("ターゲット要素が見つかりませんでした。");
        }
    }

    /**
     * 現在のURLがスクリプトを実行すべきチャット画面かどうかをチェックする関数
     * @param {string} currentUrl - 現在の window.location.href
     * @returns {boolean} - スクリプトを実行すべきチャット画面なら true
     */
    function isChatPage(currentUrl) {
        const url = currentUrl.toLowerCase();
        const urlObj = new URL(url); // URLオブジェクト

        // searchが空文字列でなければ '?' を含みます (例: '/search?udm=50')
        const pathAndQuery = urlObj.pathname + urlObj.search;

        // --- ヘルパー関数: パスパターンを正規表現に変換 ---
        const pathToRegex = (path) => {
            // 正規表現の特殊文字のうち、'*'以外をエスケープする
            let escapedPath = path.replace(/[-\\^$+?.()|[\]{}]/g, '\\$&');
            // ワイルドカード '*' を、あらゆる文字の集合にマッチさせる正規表現に変換
            // 💡 変更点: ワイルドカード '*' が、もはや '/' 以外の文字に限定されない
            escapedPath = escapedPath.replace(/\*/g, '.*');
            // パターンで始まり、その後に何かあってもOK、というパターンで終了
            // ただし、pathAndQueryがURLの終端（#ハッシュなど）であれば、正規表現の終わり($)で終わる
            return new RegExp(`^${escapedPath}$`); // $をつけることで、パターン以降に文字がないことを確認する
        };

        // --- 1. ホワイトリストチェック (許可パターン) ---
        const isWhiteListed = WHITELIST_PATHS.some(path => {
            // ルート ('/') は完全一致で確認するわ
            if (path === '/') {
                return pathAndQuery === '/';
            }

            // 正規表現でマッチするかチェック
            return pathAndQuery.match(pathToRegex(path));
        });

        // ホワイトリストに全くマッチしないなら、問答無用で false よ
        if (!isWhiteListed) {
            return false;
        }

        // --- 2. ブラックリストチェック (除外パターン) ---
        const isBlackListed = BLACKLIST_PATHS.some(path => {
            return pathAndQuery.match(pathToRegex(path));
        });

        // --- 3. 最終判断 ---
        return !isBlackListed;
    }

    // MutationObserverのロジック
    function observeDOMChanges() {
        // 監視ノードをdocument.bodyに固定
        const TARGET_NODE = document.body;
        let allResponseContainers = null;
        let footerSelector = '';
        const observer = new MutationObserver(function(mutations, observer) {
            // URLチェック: チャットページでない場合は、debouncerを起動せず即座に終了するわ
            if (!isChatPage(window.location.href)) {
                return; // DOM変更を無視して、何もしないで return するわ
            }

            // DOM操作が落ち着くまで待つ（デバウンス）
            clearTimeout(debounceTimerId);
            debounceTimerId = setTimeout(function() {
                addConvertButton();

                if (audioContext && isPause && audioContext.currentTime > 0) {
                    isPause = false;
                    isPlaying = true;
                    updateButtonState();
                    showToast('🔊 再生開始！素敵な声が聞こえてくるわ！', true);
                }

                // 自動再生ロジック
                const currentConfig = GM_getValue(STORE_KEY, config);
                const button = document.getElementById('convertButton');

                // 自動再生がONで、ボタンが存在し、再生/合成中でなく、まだ自動再生されていない場合
                if (currentConfig.autoPlay && button) {
                    // 正確な最新回答パネルの特定
                    for (const selector of SELECTORS_RESPONSE) {
                        const containers = document.querySelectorAll(selector.container);
                        if (containers.length > 0) {
                            allResponseContainers = containers;
                            footerSelector = selector.footer;
                            break;
                        }
                    }
                    if (!allResponseContainers || allResponseContainers.length === 0) {
                        return;
                    }
                    const answerContainer = allResponseContainers[allResponseContainers.length - 1]; // 最後の回答パネルを取得
                    const hasFooter = (answerContainer && footerSelector) ? answerContainer.querySelector(footerSelector) : null;
                    const minLength = currentConfig.minTextLength || 0;
                    const currentText = getGeminiAnswerText();

                    // フッターがあり＆最小文字数を超えている＆キャッシュと比較して別のものの場合に自動再生
                    if (currentText && currentText !== lastAutoPlayedText && currentText.length > 0) {
                        if (DEBUG_TEXT) {
                            console.log(`--- [Debug] [${getFormattedDateTime()}] mutation: ---\n${currentText}\n------------`);
                        }
                        if (currentText.length <= minLength) {
                            console.log(`読み上げテキストが最小文字数(${minLength}文字)以下です（${currentText.length}文字）: ${currentText.substring(0, 40)}...`);
                        } else if (hasFooter) {
                            lastAutoPlayedText = currentText;
                            startConversion(true); // trueで自動再生として実行
                        }
                    }
                }
            }, DEBOUNCE_DELAY);
        });

        const observerConfig = {
            childList: true,
            subtree: true,
        };
        observer.observe(TARGET_NODE, observerConfig);

        // 初回レンダリング現象対策
        if (isChatPage(window.location.href)) {
            let initialRetryCount = 0;
            const initialRetryLimit = 20; // 20回（約10秒）で諦める

            const initialRetryInterval = setInterval(() => {
                initialRetryCount++;
                // console.log(`[Fix] 初回発動リトライ #${initialRetryCount}`);

                // ここでも念のためチェック（URLが変わる可能性もある）
                if (!isChatPage(window.location.href)) {
                    // console.log("[Fix] URLがチャットページじゃなくなったのでリトライ中止");
                    clearInterval(initialRetryInterval);
                    return;
                }

                addConvertButton();

                // 成功判定
                if (document.getElementById('convertButton')) {
                    // console.log("[Fix] 初回ボタン成功！これで安心だね！");
                    clearInterval(initialRetryInterval);
                } else if (initialRetryCount >= initialRetryLimit) {
                    // console.log("[Fix] 初回リトライ上限…でも次からはdebounceで大丈夫！");
                    clearInterval(initialRetryInterval); // initialRetryLimit で諦める (20回で約10秒)
                }
            }, 500);

            // クリック保険もガード付き
            const clickHandler = () => {
                if (isChatPage(window.location.href)) {
                    // console.log("[Fix] クリックで強制発動！");
                    addConvertButton();
                }
                document.removeEventListener('click', clickHandler);
            };
            document.addEventListener('click', clickHandler, {
                once: true,
                capture: true,
            });
        }
    }

    // メニュー登録
    if (settingsMenuId) {
        GM_unregisterMenuCommand(settingsMenuId);
    }
    if (rvcSettingsMenuId) {
        GM_unregisterMenuCommand(rvcSettingsMenuId);
    }
    if (DownloadMenuId) {
        GM_unregisterMenuCommand(DownloadMenuId);
    }
    settingsMenuId = GM_registerMenuCommand('🔊 VOICEVOX連携 設定', openSettings);
    rvcSettingsMenuId = GM_registerMenuCommand('🔊 RVC連携 設定', openRvcSettings);
    DownloadMenuId = GM_registerMenuCommand('💾 ダウンロード', startVoiceDownload);

    const initialConfig = GM_getValue(STORE_KEY, config);
    if (!initialConfig.autoPlay) {
        loadRvcModel(initialConfig); // RVCモデルを初回起動時にロード（自動読み上げOFF時）
    }

    // DOM監視を開始
    observeDOMChanges();

    // グローバルキーイベントリスナー
    document.addEventListener('keydown', handleGlobalKeyDown);

    // 画面のどこをクリックしても、待機中なら再開させる
    document.addEventListener('click', () => {
        // isPause が true で、かつ AudioContext がサスペンド状態なら再開！
        if (isPause && audioContext && audioContext.state === 'suspended') {
            if (DEBUG) {
                console.log('[Autoplay] 画面クリックを検知。再生を再開するわ！');
            }
            resumeContext();
        }
    }, { capture: true, }); // 他の要素のクリックイベントより先に捕まえるために capture を使うのがおすすめ

})();