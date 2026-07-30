---
"@lifo-sh/core": patch
---

Bump browser-metro to 1.0.33: `Alert.alert` / `Alert.prompt` now work in the web preview — the react-native shim renders an iOS-style DOM dialog (all button counts, cancel/destructive styles, prompt input) instead of react-native-web's silent no-op. Also carries the router-shim blob-uuid route fix line (1.0.32).
