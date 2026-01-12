@echo off
echo RVCの一時ファイルを削除中...

:: Gradioが一時ファイルを作成するテンポラリフォルダ (Windowsの場合)
set TEMP_DIR=%TEMP%

:: 【1】VOICEVOXからアップロードされた一時ファイル（元音声のパス）
del /Q "%TEMP_DIR%\voicevox_source*.wav"
del /Q "%TEMP_DIR%\voicevox_source*.mp3"
del /Q "%TEMP_DIR%\voicevox_source*.flac"
del /Q "%TEMP_DIR%\voicevox_source*.m4a"

:: 【2】RVCが生成した変換後のwavファイル
del /Q "%TEMP_DIR%\tmp*.wav"

echo 削除完了。
