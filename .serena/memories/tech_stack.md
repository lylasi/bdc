## Tech Stack

- **Frontend**: HTML5, CSS3, JavaScript (ES6+)
- **Data Storage**: Browser `localStorage` is used for persisting user data like vocabulary books and analysis history.
- **AI Integration**: The application calls an external GPT-style API (configurable in `ai-config.js`) for:
  - Generating example sentences.
  - Analyzing word semantics and grammar.
  - Checking user-created sentences.
- **Text-to-Speech (TTS)**: An external TTS service is used for audio playback of words and articles.