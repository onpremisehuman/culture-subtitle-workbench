# 문화자막 작업함 · Culture Subtitle Workbench

모르는 언어의 영상을 한국어로 번역하고, 대사만 번역해서는 이해하기 어려운 시대·지역·계층·밈·말장난에 `※ 역주`를 붙여 나중에 편하게 감상하는 로컬 작업함입니다.

YouTube 또는 내 컴퓨터의 영상을 큐에 넣으면 로컬 Whisper가 타임코드를 잡고, 로그인된 Codex CLI가 번역과 문화주석을 작성합니다. 완성된 자막은 원래 YouTube 플레이어 위에 띄우거나 작업함의 로컬 플레이어에서 볼 수 있습니다.

> This is a local-first Korean cultural-subtitle workbench and Codex skill. The interface is currently Korean; transcription supports multiple source languages.

## 주요 기능

- YouTube 및 로컬 영상의 다국어 음성 전사
- 경제형·문화역주·고인물판 자막 농도
- 포르투갈어, 튀르키예어, 페르시아어, 스페인어, 아랍어, 일본어, 중국어, 러시아어, 폴란드어 등 자동 감지 또는 직접 지정
- 반복 문구·저고유도 전사 환각 품질 게이트와 보수적 자동 재시도
- Chrome/Edge의 원본 YouTube 플레이어 위 자막 오버레이
- 로컬 작업함, 재생목록, 숨기기, 삭제, 완료 알림
- SRT, 자막을 입힌 MP4, MP4+SRT 내보내기
- 자막 크기와 폰트 선택, 반응형 두 줄 배치, 로컬 영상 항상 위에 보기
- 콘솔 창 없는 Windows 로그인 자동실행

## 필요한 것

- Windows 10/11
- Python 3.10 이상
- FFmpeg
- Chrome 또는 Edge
- 로그인된 [Codex CLI](https://github.com/openai/codex)

Python 패키지 `openai-whisper`와 `yt-dlp`는 설치 스크립트가 설치합니다. 첫 Whisper 실행에서는 선택한 모델을 내려받으므로 시간이 걸리고 저장공간이 필요합니다. 기본 모델은 `large-v3-turbo`입니다.

## 설치

Codex 스킬로 바로 설치하려면 PowerShell에서 다음을 실행합니다.

```powershell
git clone https://github.com/onpremisehuman/culture-subtitle-workbench.git "$HOME\.codex\skills\culture-subtitle-workbench"
Set-Location "$HOME\.codex\skills\culture-subtitle-workbench"
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

FFmpeg까지 winget으로 설치하고 로그인할 때 서버가 자동으로 켜지게 하려면:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -InstallFfmpeg -RegisterAutostart
```

이미 다른 위치에 clone했다면 그 폴더를 `.codex/skills/culture-subtitle-workbench`에 심볼릭 링크해도 됩니다. 설치 후 새 Codex 작업을 열면 `$culture-subtitle-workbench`로 호출할 수 있습니다.

## 실행과 확장 설치

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

작업함은 `http://127.0.0.1:8876/app/`에서 열립니다.

1. Chrome에서 `chrome://extensions`를 엽니다.
2. 개발자 모드를 켭니다.
3. `압축해제된 확장 프로그램을 로드합니다`를 누릅니다.
4. 이 저장소의 `app/extension` 폴더를 선택합니다.
5. 열려 있던 YouTube 탭을 새로고침합니다.

## 사용량과 개인정보

- Whisper 음성 인식은 로컬에서 실행됩니다.
- 번역에는 이 PC에 로그인된 Codex CLI 세션이 사용됩니다. 확장 프로그램에 API 키를 넣지 않습니다.
- 영상별 데이터는 `app/data/`에만 저장되며 Git에서 제외됩니다.
- 전사용 `source_audio.wav`는 작업 성공·실패 여부와 관계없이 처리 뒤 자동 삭제됩니다.
- 사용자의 Codex 플랜, 모델 접근 권한과 사용 한도에 따라 작업 가능량이 달라질 수 있습니다.

## 구조: 번역 백엔드를 Codex 구독에서 빌려 씀

이 작업함은 별도 번역 서버나 API 키를 두지 않고, 사용자가 이미 로그인해 둔 Codex CLI를 `codex exec`로 불러 번역합니다. 그래서 Codex를 쓰지 않는 사람에게는 번역 단계가 동작하지 않습니다.

- 장점: 추가 과금·키 관리가 없고, 비밀키가 코드나 확장에 들어갈 일이 없습니다. 모델 교체도 `CULTURE_SUB_MODEL` 한 줄이면 됩니다.
- 한계: Codex CLI는 번역 API가 아니라 에이전트라서 호출마다 에이전트 준비 비용이 붙고, CLI 업데이트·로그인 만료·사용 한도에 따라 동작이 달라질 수 있습니다. 이를 줄이려고 원문을 프롬프트에 직접 넣어 파일 접근 없이 답하게 하고, 결과를 구간별로 검수·재시도합니다.
- 전사(Whisper)와 다운로드(yt-dlp)는 Codex와 무관하게 로컬에서 동작합니다.

## 권리와 책임

이 도구는 본인이 소유했거나 사용 허가를 받은 영상, 퍼블릭도메인 등 적법하게 처리할 수 있는 미디어를 위한 것입니다. 접근 통제나 DRM을 우회하지 마십시오. YouTube MP4 및 MP4+SRT 내보내기는 필요한 권리가 있는 경우에만 사용하십시오. 저장소 공개와 오픈소스 라이선스가 제3자 콘텐츠에 대한 권리를 부여하지는 않습니다.

## 점검

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
python -m unittest discover -s app/tests -v
```

## 설정

- `CULTURE_WHISPER_MODEL`: Whisper 모델 변경
- `CULTURE_SUB_MODEL`: 세 자막 농도에서 사용할 Codex 모델 강제 지정
- `CULTURE_TRANSLATION_CHUNK`: 한 번에 번역할 발화 수(기본 200)
- `CULTURE_TRANSLATION_PARALLEL`: 동시에 번역할 구간 수(기본 2)
- `CULTURE_TRUST_TAILSCALE=1`: `--lan` 모드에서 Tailscale 노드(100.64.0.0/10)에 페어링 토큰 자동 발급. 기본값은 이 PC에서만 자동 발급
- 기본 서버 주소: `127.0.0.1:8876`

## 라이선스

애플리케이션 코드는 [MIT License](LICENSE)입니다. A2Z 글꼴을 포함한 외부 구성요소는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 확인하십시오.
