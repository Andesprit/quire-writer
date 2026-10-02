#!/usr/bin/env python3
"""The narration, spoken locally by Kokoro (voice af_heart), one clip per line of src/script.json.

Run it with a Python that has kokoro-onnx and soundfile, for example the video-vox one:
    ../../video-vox/.venv/bin/python scripts/voice.py
KOKORO_MODELS points at kokoro-v1.0.onnx and voices-v1.0.bin (default: ../../video-vox/models).
Writes public/voice/<id>.wav and src/voice.json, the length of each clip. A line whose text did
not change is not spoken again.
"""
import hashlib
import json
import os
from pathlib import Path

import soundfile as sf
from kokoro_onnx import Kokoro

ROOT = Path(__file__).resolve().parent.parent
MODELS = Path(os.environ.get("KOKORO_MODELS", ROOT.parent.parent / "video-vox" / "models"))
VOICE = "af_heart"
SPEED = 1.0
# espeak says these two names the wrong way: "tipst" and "la-tee-ex".
FIX = {"tˈɪpst": "tˈaɪpst", "lˌæ tˈiː ˈɛks": "lˈeɪtˈɛk"}


def main() -> None:
    script = json.loads((ROOT / "src/script.json").read_text())
    out = ROOT / "public/voice"
    out.mkdir(parents=True, exist_ok=True)
    timing_path = ROOT / "src/voice.json"
    old = json.loads(timing_path.read_text()) if timing_path.exists() else {}
    kokoro = Kokoro(str(MODELS / "kokoro-v1.0.onnx"), str(MODELS / "voices-v1.0.bin"))

    timing = {}
    for scene in script["scenes"]:
        for line in scene["beats"]:
            text = line.get("say", line["text"])
            key = hashlib.sha1(f"{VOICE}|{SPEED}|{json.dumps(FIX)}|{text}".encode()).hexdigest()[:12]
            wav = out / f"{line['id']}.wav"
            if old.get(line["id"], {}).get("key") == key and wav.exists():
                timing[line["id"]] = old[line["id"]]
                continue
            phonemes = kokoro.tokenizer.phonemize(text, "en-us")
            for wrong, right in FIX.items():
                phonemes = phonemes.replace(wrong, right)
            samples, rate = kokoro.create(phonemes, voice=VOICE, speed=SPEED, lang="en-us", is_phonemes=True)
            sf.write(wav, samples, rate)
            timing[line["id"]] = {"key": key, "seconds": round(len(samples) / rate, 3)}
            print(f"{line['id']}: {timing[line['id']]['seconds']} s")

    timing_path.write_text(json.dumps(timing, indent=1) + "\n")
    print(f"{sum(t['seconds'] for t in timing.values()):.1f} s of narration")


if __name__ == "__main__":
    main()
