## Code Style and Conventions

Based on `app.js`, the project follows these conventions:

- **Structure**: The code is organized into logical sections using comments (Global Variables, DOM Elements, Initialization, Feature Functions, etc.).
- **Naming**: Variable and function names are descriptive and use camelCase (e.g., `vocabularyBooks`, `renderVocabBookList`). DOM element variables are consistently named (e.g., `addVocabBookBtn`).
- **Modularity**: Functions are kept focused on a single responsibility (e.g., `saveVocabularyBooks`, `renderWordList`).
- **Configuration**: Sensitive or environment-specific values like API keys are kept in a separate `ai-config.js` file, which is not checked into version control (as evidenced by `.gitignore`).