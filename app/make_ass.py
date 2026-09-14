from __future__ import annotations

import argparse
import re
from pathlib import Path


TIMING = re.compile(
    r"(?P<sh>\d{2}):(?P<sm>\d{2}):(?P<ss>\d{2}),(?P<sms>\d{3})\s+-->\s+"
    r"(?P<eh>\d{2}):(?P<em>\d{2}):(?P<es>\d{2}),(?P<ems>\d{3})"
)


def ass_time(hour: str, minute: str, second: str, millis: str) -> str:
    return f"{int(hour)}:{minute}:{second}.{int(millis) // 10:02d}"


def escape_ass(text: str) -> str:
    return text.replace("{", "（").replace("}", "）").replace("\n", r"\N")


def convert(source: Path, target: Path) -> None:
    blocks = source.read_text(encoding="utf-8-sig").replace("\r", "").strip().split("\n\n")
    events: list[str] = []
    for block in blocks:
        lines = block.splitlines()
        timing_index = next((index for index, line in enumerate(lines) if "-->" in line), -1)
        if timing_index < 0:
            continue
        match = TIMING.search(lines[timing_index])
        if not match:
            continue
        text = "\n".join(lines[timing_index + 1 :]).strip()
        start = ass_time(match["sh"], match["sm"], match["ss"], match["sms"])
        end = ass_time(match["eh"], match["em"], match["es"], match["ems"])
        marker = "※ 역주:"
        if marker in text and not text.startswith(marker):
            dialogue, note = text.split(marker, 1)
            events.append(f"Dialogue: 0,{start},{end},Default,,0,0,0,,{escape_ass(dialogue.strip())}")
            events.append(f"Dialogue: 1,{start},{end},Note,,0,0,0,,{escape_ass(marker + note.strip())}")
        else:
            style = "Note" if text.startswith(marker) else "Default"
            events.append(f"Dialogue: 0,{start},{end},{style},,0,0,0,,{escape_ass(text)}")

    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Malgun Gothic,38,&H00FFFFFF,&H00FFFFFF,&H00101010,&H78000000,-1,0,0,0,100,100,0,0,1,2.4,0.8,2,55,55,42,1
Style: Note,Malgun Gothic,29,&H0000E8FF,&H0000E8FF,&H00101010,&HA0000000,-1,0,0,0,100,100,0,0,3,1.4,0,8,65,65,44,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    target.write_text(header + "\n".join(events) + "\n", encoding="utf-8-sig")


def main() -> None:
    parser = argparse.ArgumentParser(description="문화자막 SRT를 상·하단 분리 ASS로 변환")
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    args = parser.parse_args()
    convert(args.source, args.target)


if __name__ == "__main__":
    main()
