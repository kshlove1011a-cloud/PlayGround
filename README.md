# PlayGround

<!-- omgithub:readme:start -->
## 🚀 Build, play, and remix with OMGithub

**Created using [OMGithub.com](https://omgithub.com).**

[![OMGithub](https://img.shields.io/badge/OMGithub-Open%20project-orange?style=for-the-badge)](https://omgithub.com/kshlove1011a-cloud/PlayGround)
[![GitHub](https://img.shields.io/badge/GitHub-Source-181717?logo=github&style=for-the-badge)](https://github.com/kshlove1011a-cloud/PlayGround)

- 🎮 [Open the project](https://omgithub.com/kshlove1011a-cloud/PlayGround).
- ✨ [Remix this project](https://omgithub.com/?remix=kshlove1011a-cloud%2FPlayGround).
- 💻 [Explore the source](https://github.com/kshlove1011a-cloud/PlayGround).
- 🛠️ [Check build runs](https://github.com/kshlove1011a-cloud/PlayGround/actions).
- 🐛 [Report an issue](https://github.com/kshlove1011a-cloud/PlayGround/issues).
- 👤 [Explore the creator's projects](https://omgithub.com/kshlove1011a-cloud).
- 🌍 [Create with OMGithub](https://omgithub.com).
<!-- omgithub:readme:end -->

## NEON CUT — 리듬 슬래셔

다가오는 네온 적이 전방의 링에 닿는 순간, 화면을 탭해 베어내는 48초 모바일 리듬 게임입니다.

- **탭 / 클릭 / Space**: 적을 벨 타이밍 입력
- **P / Esc**: 일시정지 · 재개
- **M 또는 ♪ 버튼**: 음소거
- 실드 5개로 시작하며, 놓친 적마다 하나씩 잃습니다. 20 콤보마다 실드가 회복됩니다.
- PERFECT · GREAT · GOOD 판정과 콤보 배율로 점수를 쌓고, 골드 적은 실드를 회복시킵니다.

### 실행

```bash
python3 -m http.server 3002
# http://localhost:3002
```

빌드 도구 없이 `index.html`, `style.css`, `game.js`만으로 동작합니다. 배경은 한 번만 그려 두고, 적 스프라이트와 음원도 미리 렌더링하며, 기기 프레임 시간에 따라 해상도를 자동으로 낮춰 모바일에서 렉을 줄입니다.
