import os
import traceback

import librosa
import numpy as np
import av
from io import BytesIO

import glob # 追加

def wav2(i, o, format):
    inp = av.open(i, "rb")
    if format == "m4a":
        format = "mp4"
    out = av.open(o, "wb", format=format)
    if format == "ogg":
        format = "libvorbis"
    if format == "mp4":
        format = "aac"

    ostream = out.add_stream(format)

    for frame in inp.decode(audio=0):
        for p in ostream.encode(frame):
            out.mux(p)

    for p in ostream.encode(None):
        out.mux(p)

    out.close()
    inp.close()

def audio2(i, o, format, sr):
    inp = av.open(i, "rb")
    out = av.open(o, "wb", format=format)
    if format == "ogg":
        format = "libvorbis"
    if format == "f32le":
        format = "pcm_f32le"

    ostream = out.add_stream(format, channels=1)
    ostream.sample_rate = sr

    for frame in inp.decode(audio=0):
        for p in ostream.encode(frame):
            out.mux(p)

    out.close()
    inp.close()

def load_audio(file, sr):
    # ★★★ クールな修正 V7.0: ワイルドカード検索！ (ファイルの先頭で glob を import)★★★
    # 1. パス文字列のクリーンアップ
    file_to_check = (
        file.strip(" ").strip('"').strip("\n").strip('"').strip(" ")
    ) 

    # 2. ファイルが見つからない場合のワイルドカード検索
    if os.path.exists(file_to_check) == False:
        # ランダム文字に対応するため、ファイル名の拡張子の前に '*' を追加して再検索する
        base_name = os.path.basename(file_to_check)
        if "." in base_name and file_to_check != "":
            # 例: voicevox_source.wav -> voicevox_source*.wav
            search_path = file_to_check.rsplit(".", 1)[0] + "*" + "." + file_to_check.rsplit(".", 1)[1]
            found_files = glob.glob(search_path)
            
            if len(found_files) > 0:
                # ランダムなテンポラリファイルが見つかった！
                file_to_check = found_files[0]
            else:
                # ファイルが見つからなかった場合は、元のエラーを出す
                raise RuntimeError(
                    "You input a wrong audio path that does not exists, please fix it!"
                )
        else:
             # 空文字列か拡張子がない場合は、そのままエラーを出す (vc_single側で弾くことを期待)
             raise RuntimeError(
                "You input a wrong audio path that does not exists, please fix it!"
            )
            
    # 3. 処理続行 (原本のコードを維持)
    try:
        with open(file_to_check, "rb") as f: # ここに正しいパスが入るはず
            with BytesIO() as out:
                audio2(f, out, "f32le", sr)
                return np.frombuffer(out.getvalue(), np.float32).flatten()

    except AttributeError:
        audio = file[1] / 32768.0
        if len(audio.shape) == 2:
            audio = np.mean(audio, -1)
        return librosa.resample(audio, orig_sr=file[0], target_sr=16000)

    except:
        raise RuntimeError(traceback.format_exc())
