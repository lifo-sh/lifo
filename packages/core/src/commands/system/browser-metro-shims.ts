/**
 * bundler-shims.ts
 *
 * Virtual module source strings injected into every project bundle by the
 * expo-web bundler plugin. They run inside the iframe, not in this process,
 * so they must be self-contained ES5-compatible JS strings.
 *
 * Three shims are provided:
 *  1. GLOBALS_PREAMBLE       — prepended to the final bundle output
 *  2. CLASSNAME_PATCH_MODULE — registered as "__classname-patch__"
 *  3. NATIVEWIND_SHIM        — registered as "nativewind"
 */

/**
 * Ensures React Native globals (__DEV__, global) exist in the browser
 * before any app code runs. Prepended to the bundler output by expoWebPlugin.
 */
export const GLOBALS_PREAMBLE =
  "if(typeof __DEV__==='undefined')globalThis.__DEV__=true;\n" +
  "if(typeof global==='undefined')globalThis.global=globalThis;\n" +
  // Install the `globalThis.expo` runtime that expo-modules-core's web build
  // normally sets up via installExpoGlobalPolyfill() (polyfill/index.web.ts).
  // On a device the JSI installs it; on Expo web the polyfill side-effect does.
  // Our bundle doesn't run that side-effect, so `globalThis.expo.NativeModule`
  // (and EventEmitter / registerWebModule's `modules` registry) are undefined —
  // which makes any web NativeModule do `class X extends undefined` and crash at
  // module load (e.g. expo-speech-recognition). This is a guarded, minimal mirror
  // of CoreModule; the real polyfill early-returns if `globalThis.expo` exists.
  "(function(){if(globalThis.expo&&globalThis.expo.NativeModule)return;" +
  "function EE(){this.__l={};}" +
  "EE.prototype.addListener=function(n,f){(this.__l[n]=this.__l[n]||[]).push(f);var s=this;return{remove:function(){s.removeListener(n,f);}};};" +
  "EE.prototype.removeListener=function(n,f){var a=this.__l[n];if(a){var i=a.indexOf(f);if(i>=0)a.splice(i,1);}};" +
  "EE.prototype.removeAllListeners=function(n){if(n)delete this.__l[n];else this.__l={};};" +
  "EE.prototype.emit=function(n){var a=this.__l[n];if(a){var x=Array.prototype.slice.call(arguments,1);a.slice().forEach(function(f){try{f.apply(null,x);}catch(e){}});}};" +
  "EE.prototype.listenerCount=function(n){return (this.__l[n]||[]).length;};" +
  "function NM(){EE.call(this);}NM.prototype=Object.create(EE.prototype);NM.prototype.constructor=NM;" +
  "function SO(){EE.call(this);}SO.prototype=Object.create(EE.prototype);SO.prototype.constructor=SO;" +
  "var e=globalThis.expo||{};" +
  "e.EventEmitter=e.EventEmitter||EE;e.NativeModule=e.NativeModule||NM;e.SharedObject=e.SharedObject||SO;e.SharedRef=e.SharedRef||SO;" +
  "e.modules=e.modules||{};" +
  "e.uuidv4=e.uuidv4||function(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return (c==='x'?r:(r&0x3|0x8)).toString(16);});};" +
  "e.reloadAppAsync=e.reloadAppAsync||function(){try{window.location.reload();}catch(_){}return Promise.resolve();};" +
  "e.getViewConfig=e.getViewConfig||function(){throw new Error('getViewConfig is not implemented in the web preview');};" +
  "globalThis.expo=e;})();\n";

/**
 * Registered as the virtual module "__classname-patch__" and required at the
 * top of the bundle entry file so it runs before any component renders.
 *
 * Monkey-patches React.createElement so that:
 *  - Any `className` string prop is converted to a react-native-web $$css
 *    style object, letting Tailwind CDN class names work with RNW components.
 *  - Any `__cssVars` style objects (produced by nativewind's `vars()`) are
 *    applied as inline CSS custom properties via a ref injected onto the element.
 */
export const CLASSNAME_PATCH_MODULE = `
var React = require("react");
var _orig = React.createElement;

// React's set of CSS properties whose numeric values are unitless (no px
// suffix). Mirrors React DOM's internal list. Used when applying user
// style via element.style[k] = v in a ref callback — numeric values for
// any other key default to pixels (RN convention).
var _UNITLESS = {
  animationIterationCount: true, aspectRatio: true, borderImageOutset: true,
  borderImageSlice: true, borderImageWidth: true, boxFlex: true,
  boxFlexGroup: true, boxOrdinalGroup: true, columnCount: true, columns: true,
  flex: true, flexGrow: true, flexPositive: true, flexShrink: true,
  flexNegative: true, flexOrder: true, gridArea: true, gridRow: true,
  gridRowEnd: true, gridRowSpan: true, gridRowStart: true, gridColumn: true,
  gridColumnEnd: true, gridColumnSpan: true, gridColumnStart: true,
  fontWeight: true, lineClamp: true, lineHeight: true, opacity: true,
  order: true, orphans: true, scale: true, tabSize: true, widows: true,
  zIndex: true, zoom: true,
};

// Extract __cssVars from a style prop (could be object, array, or nested)
function _extractCssVars(style) {
  if (!style) return null;
  if (style.__cssVars) return style.__cssVars;
  if (Array.isArray(style)) {
    for (var i = 0; i < style.length; i++) {
      var v = _extractCssVars(style[i]);
      if (v) return v;
    }
  }
  return null;
}

// Remove __cssVars objects from style to prevent RNW from processing them
function _cleanStyle(style) {
  if (!style) return style;
  if (style.__cssVars) return undefined;
  if (Array.isArray(style)) {
    return style.filter(function(s) { return !s || !s.__cssVars; });
  }
  return style;
}

// Strip keys with undefined values from style objects (recurses into arrays).
function _stripUndefined(style) {
  if (!style) return style;
  if (Array.isArray(style)) {
    return style.map(_stripUndefined);
  }
  if (typeof style !== "object") return style;
  var out = {};
  for (var k in style) {
    if (Object.prototype.hasOwnProperty.call(style, k) && style[k] !== undefined) {
      out[k] = style[k];
    }
  }
  return out;
}

// Apply a single style key/value to a DOM element. Numeric values get a
// px suffix unless the key is in the unitless list. Null/undefined skipped.
function _applyStyleKey(el, key, value) {
  if (value == null) return;
  if (typeof value === "number" && !_UNITLESS[key]) value = value + "px";
  try { el.style[key] = value; } catch (e) {}
}

React.createElement = function() {
  var args = Array.prototype.slice.call(arguments);
  var type = args[0];
  var props = args[1];

  if (!props || typeof type === "string") {
    return _orig.apply(this, args);
  }

  var className = (typeof props.className === "string" && props.className) ? props.className : null;
  var cssVars = _extractCssVars(props.style);

  if (!className && !cssVars) {
    return _orig.apply(this, args);
  }

  props = Object.assign({}, props);
  var cleanedStyle = _stripUndefined(_cleanStyle(props.style));

  // Build the $$css class object from className tokens.
  var cssObj = null;
  if (className) {
    cssObj = { $$css: true };
    className.split(/\\s+/).forEach(function(c) { if (c) cssObj[c] = c; });
    delete props.className;
  }

  // Detect the incompatibility case: className present AND user style is
  // a non-empty plain object containing real CSS values. styleq cannot
  // merge $$css tokens with mixed-type values — pairing them in an array
  // makes React DOM Object.assign the array onto CSSStyleDeclaration,
  // tripping its indexed-property setter ("Failed to set an indexed
  // property [0] on CSSStyleDeclaration"). Defer the user style to a
  // ref callback that writes via element.style[k] = v after mount.
  var deferredUserStyle = null;
  if (cssObj && cleanedStyle && typeof cleanedStyle === "object" && !Array.isArray(cleanedStyle)) {
    // Plain object: defer to ref only if it has any real keys. An empty
    // object (often the post-_stripUndefined shape of a buggy user style)
    // collapses to just cssObj — same as having no user style at all.
    if (Object.keys(cleanedStyle).length > 0) {
      deferredUserStyle = cleanedStyle;
    }
    props.style = cssObj;
  } else if (cssObj && Array.isArray(cleanedStyle) && cleanedStyle.length > 0) {
    // Array form — preserve previous behavior, styleq handles arrays.
    props.style = [cssObj].concat(cleanedStyle);
  } else if (cssObj) {
    props.style = cssObj;
  } else if (cssVars && (!props.style || props.style.__cssVars)) {
    // cssVars-only path with no remaining style — clear it.
    props.style = undefined;
  }

  // Compose one ref that runs cssVars, deferred user style, then chains
  // to the caller's original ref. Either or both may be active.
  if (cssVars || deferredUserStyle) {
    var existingRef = props.ref;
    var _vars = cssVars;
    var _userStyle = deferredUserStyle;
    props.ref = function(el) {
      if (el && el.style) {
        if (_vars) {
          for (var k in _vars) {
            if (Object.prototype.hasOwnProperty.call(_vars, k)) {
              el.style.setProperty(k, _vars[k]);
            }
          }
        }
        if (_userStyle) {
          for (var k2 in _userStyle) {
            if (Object.prototype.hasOwnProperty.call(_userStyle, k2)) {
              _applyStyleKey(el, k2, _userStyle[k2]);
            }
          }
        }
      }
      if (typeof existingRef === "function") existingRef(el);
      else if (existingRef && typeof existingRef === "object" && existingRef !== null) {
        existingRef.current = el;
      }
    };
  }

  args[1] = props;
  return _orig.apply(this, args);
};
module.exports = {};
`;

/**
 * Registered as the virtual module "nativewind". Provides web-compatible
 * implementations of the nativewind APIs used in React Native projects:
 *
 *  - useColorScheme: React hook that tracks light/dark preference, responds
 *    to system media-query changes, and exposes setColorScheme/toggleColorScheme.
 *  - vars: wraps a CSS-variable object in a __cssVars marker so
 *    CLASSNAME_PATCH_MODULE can apply them as inline CSS custom properties.
 *  - cssInterop / remapProps: no-ops (handled natively on web).
 *  - createStyleSheet: delegates to React Native StyleSheet.create.
 */
/**
 * Registered as the virtual module "expo-constants". Reads the project's
 * app.json at bundle time and exposes it as Constants.expoConfig so that
 * `import Constants from 'expo-constants'; Constants.expoConfig?.name`
 * works inside the browser preview.
 */
/**
 * Build the expo-constants shim with the app.json content inlined.
 * Must be called with the raw app.json string from the VFS.
 */
export function buildExpoConstantsShim(appJsonContent: string | undefined): string {
  let expoConfigJson = 'null';
  if (appJsonContent) {
    try {
      const parsed = JSON.parse(appJsonContent);
      const config = parsed.expo || parsed;
      expoConfigJson = JSON.stringify(config);
    } catch(e) {}
  }
  return `
var _expoConfig = ${expoConfigJson};

var _constants = {
  expoConfig: _expoConfig,
  manifest: _expoConfig,
  executionEnvironment: "storeClient",
  appOwnership: null,
  sessionId: "browser-metro",
  isDevice: false,
  platform: { ios: {}, android: {}, web: {} },
  getWebViewUserAgentAsync: function() { return Promise.resolve(typeof navigator !== "undefined" ? navigator.userAgent : ""); },
  installationId: "browser-metro-shim",
  statusBarHeight: 0,
  systemFonts: [],
};
module.exports = _constants;
module.exports.__esModule = true;
module.exports.default = _constants;
`;
}

export const NATIVEWIND_SHIM = `
var React = require("react");
var RN = require("react-native");

var _STORAGE_KEY = "__nativewind_color_scheme";
var _listeners = new Set();
var _userPref = null;

// Restore persisted preference from localStorage (shared across iframes)
if (typeof window !== "undefined" && window.localStorage) {
  try { _userPref = window.localStorage.getItem(_STORAGE_KEY); } catch(e) {}
}

function _getSystemScheme() {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

function _getEffective() {
  return (_userPref === "system" || _userPref === null) ? _getSystemScheme() : _userPref;
}

function _persistAndBroadcast(pref) {
  _userPref = pref;
  if (typeof window !== "undefined" && window.localStorage) {
    try { window.localStorage.setItem(_STORAGE_KEY, pref); } catch(e) {}
  }
  var eff = _getEffective();
  _listeners.forEach(function(l) { l(eff); });
}

if (typeof window !== "undefined") {
  // Sync across iframes via localStorage storage event
  window.addEventListener("storage", function(e) {
    if (e.key === _STORAGE_KEY && e.newValue) {
      _userPref = e.newValue;
      var eff = _getEffective();
      _listeners.forEach(function(l) { l(eff); });
    }
  });
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function() {
      if (_userPref === "system" || _userPref === null) {
        _listeners.forEach(function(l) { l(_getEffective()); });
      }
    });
  }
}

exports.useColorScheme = function useColorScheme() {
  var _s = React.useState(function() { return _getEffective(); });
  var colorScheme = _s[0], setCS = _s[1];

  React.useEffect(function() {
    var listener = function(s) { setCS(s); };
    _listeners.add(listener);
    return function() { _listeners.delete(listener); };
  }, []);

  return {
    colorScheme: colorScheme,
    setColorScheme: function(scheme) {
      _persistAndBroadcast(scheme);
      var eff = scheme === "system" ? _getSystemScheme() : scheme;
      setCS(eff);
    },
    toggleColorScheme: function() {
      var next = colorScheme === "dark" ? "light" : "dark";
      _persistAndBroadcast(next);
      setCS(next);
    }
  };
};

exports.vars = function vars(obj) {
  var result = {};
  result.__cssVars = obj;
  return result;
};

exports.cssInterop = function cssInterop(Component) {
  return Component;
};

exports.remapProps = function remapProps(Component) {
  return Component;
};

exports.createStyleSheet = function createStyleSheet(styles) {
  return RN.StyleSheet.create(styles);
};
`;

/**
 * Shim for @expo-google-fonts/* packages.
 * Returns useFonts as a stub that always returns [true, null] (fonts are loaded
 * via Google Fonts CSS in the browser preview). Any named export (font variant
 * names like Oswald_700Bold) returns an empty string — the actual font rendering
 * is handled by @font-face CSS injected into the bundle HTML.
 *
 * Uses a Proxy so ANY named import resolves without needing to enumerate every
 * possible font variant ahead of time.
 */
/**
 * Shim for expo-font.
 * The real expo-font uses native APIs that don't work in the browser preview.
 * This shim provides a useFonts() that registers fonts via CSS @font-face
 * using the data URL sources from the bundled @expo-google-fonts/* packages.
 */
export const EXPO_FONT_SHIM = `
var _registered = {};
function useFonts(fontMap) {
  if (fontMap && typeof document !== 'undefined') {
    var entries = Object.entries(fontMap);
    for (var i = 0; i < entries.length; i++) {
      var name = entries[i][0], src = entries[i][1];
      if (src && typeof src === 'string' && !_registered[name]) {
        _registered[name] = true;
        var style = document.createElement('style');
        style.textContent = '@font-face { font-family: "' + name + '"; src: url("' + src + '"); }';
        document.head.appendChild(style);
      }
    }
  }
  return [true, null];
}
exports.useFonts = useFonts;
exports.loadAsync = function loadAsync() { return Promise.resolve(); };
exports.isLoaded = function isLoaded() { return true; };
exports.isLoading = function isLoading() { return false; };
exports.default = exports;
`;

/**
 * Shim for react-native-reanimated.
 * The real reanimated requires native worklet runtime which doesn't exist in
 * the browser preview. This shim provides a web-compatible implementation
 * using requestAnimationFrame-based animations.
 *
 * Injected via VFS + resolveRequest (not shimModules) to avoid changing the
 * dependency batch hash used for package prefetching.
 */
export const REANIMATED_SHIM = `
var React = require("react");
var RN = require("react-native");

// Mock worklet runtime
if (typeof global !== "undefined" && !global._WORKLET_RUNTIME) {
  global._WORKLET_RUNTIME = { createWorklet: function(fn) { return fn; }, runOnJS: function(fn) { return function() { return fn.apply(null, arguments); }; }, runOnUI: function(fn) { return function() { return fn.apply(null, arguments); }; }, makeShareableClone: function(v) { return v; } };
  global._IS_WORKLET_RUNTIME = false;
  global.__reanimatedWorkletInit = function() {};
}
if (typeof window !== "undefined" && !window._WORKLET_RUNTIME) {
  window._WORKLET_RUNTIME = global._WORKLET_RUNTIME;
  window._IS_WORKLET_RUNTIME = false;
  window.__reanimatedWorkletInit = function() {};
}

// SharedValue class with animation support
function SharedValue(initialValue) {
  this._value = initialValue;
  this._listeners = new Set();
  this._animationId = null;
  this._springState = null;
}

SharedValue.prototype = {
  get value() { return this._value; },
  set value(newValue) {
    if (this._animationId !== null) {
      if (typeof this._animationId === "number") cancelAnimationFrame(this._animationId);
      else clearTimeout(this._animationId);
      this._animationId = null;
    }
    if (newValue && typeof newValue === "object" && newValue.__isAnimationDescriptor) {
      this._startAnimation(newValue);
    } else {
      this._setValue(newValue);
    }
  },
  _setValue: function(v) {
    if (this._value !== v) { this._value = v; this._listeners.forEach(function(l) { l(v); }); }
  },
  _startAnimation: function(desc) {
    var self = this;
    var type = desc.type;
    var toValue = desc.toValue;
    var config = desc.config || {};
    var callback = desc.callback;
    var fromValue = typeof this._value === "number" ? this._value : 0;
    var startTime = performance.now();

    if (type === "delay") {
      var delayMs = desc.delayMs || 0;
      var inner = desc.inner;
      this._animationId = setTimeout(function() {
        self._animationId = null;
        if (inner && typeof inner === "object" && inner.__isAnimationDescriptor) {
          self._startAnimation(inner);
        } else if (inner !== undefined) {
          self._setValue(typeof inner === "number" ? inner : inner);
        }
      }, delayMs);
      return;
    }

    if (type === "sequence") {
      var anims = desc.animations || [];
      var idx = 0;
      var runNext = function() {
        if (idx >= anims.length) { if (callback) callback(true); return; }
        var anim = anims[idx++];
        if (anim && typeof anim === "object" && anim.__isAnimationDescriptor) {
          var origCb = anim.callback;
          anim.callback = function(finished) { if (origCb) origCb(finished); runNext(); };
          self._startAnimation(anim);
        } else {
          if (typeof anim === "number") self._setValue(anim);
          runNext();
        }
      };
      runNext();
      return;
    }

    if (type === "repeat") {
      var innerAnim = desc.inner;
      var reps = desc.numberOfReps;
      var reverse = desc.reverse;
      var count = 0;
      var origFrom = fromValue;
      var runRep = function() {
        if (reps > 0 && count >= reps) { if (callback) callback(true); return; }
        count++;
        var anim = JSON.parse(JSON.stringify(innerAnim));
        anim.__isAnimationDescriptor = true;
        if (reverse && count % 2 === 0) {
          var tmp = anim.toValue; anim.toValue = origFrom; origFrom = tmp;
        }
        anim.callback = function() { runRep(); };
        self._startAnimation(anim);
      };
      runRep();
      return;
    }

    var animate = function(currentTime) {
      var elapsed = currentTime - startTime;
      if (type === "timing") {
        var duration = config.duration !== undefined ? config.duration : 300;
        var easing = config.easing || function(t) { return t; };
        if (elapsed >= duration) {
          self._setValue(toValue);
          self._animationId = null;
          if (callback) callback(true);
          return;
        }
        var progress = easing(elapsed / duration);
        self._setValue(fromValue + (toValue - fromValue) * progress);
        self._animationId = requestAnimationFrame(animate);
      } else if (type === "spring") {
        var damping = config.damping !== undefined ? config.damping : 10;
        var stiffness = config.stiffness !== undefined ? config.stiffness : 100;
        var mass = config.mass !== undefined ? config.mass : 1;
        if (!self._springState) { self._springState = { velocity: config.velocity || 0, position: fromValue }; }
        var dt = 1 / 60;
        var sf = -stiffness * (self._springState.position - toValue);
        var df = -damping * self._springState.velocity;
        var acc = (sf + df) / mass;
        self._springState.velocity += acc * dt;
        self._springState.position += self._springState.velocity * dt;
        self._setValue(self._springState.position);
        if (Math.abs(self._springState.velocity) < 0.01 && Math.abs(self._springState.position - toValue) < 0.01) {
          self._setValue(toValue); self._springState = null; self._animationId = null; if (callback) callback(true); return;
        }
        self._animationId = requestAnimationFrame(animate);
      }
    };
    this._animationId = requestAnimationFrame(animate);
  },
  addListener: function(listener) {
    var self = this;
    this._listeners.add(listener);
    return function() { self._listeners.delete(listener); };
  }
};

// Hooks
function useSharedValue(initialValue) {
  var ref = React.useRef(null);
  if (ref.current === null) ref.current = new SharedValue(initialValue);
  return ref.current;
}

function useAnimatedStyle(styleFactory, deps) {
  var _s = React.useReducer(function(x) { return x + 1; }, 0);
  var forceUpdate = _s[1];
  var styleRef = React.useRef({});
  var listenersRef = React.useRef([]);

  var computeStyle = function() {
    listenersRef.current.forEach(function(u) { u(); });
    listenersRef.current = [];
    var accessed = [];
    var origGet = Object.getOwnPropertyDescriptor(SharedValue.prototype, "value").get;
    Object.defineProperty(SharedValue.prototype, "value", {
      get: function() { accessed.push(this); return origGet.call(this); }, configurable: true
    });
    try { styleRef.current = styleFactory(); } catch(e) { styleRef.current = {}; }
    Object.defineProperty(SharedValue.prototype, "value", { get: origGet, configurable: true });
    accessed.forEach(function(sv) {
      var unsub = sv.addListener(function() { styleRef.current = styleFactory(); forceUpdate(); });
      listenersRef.current.push(unsub);
    });
    return styleRef.current;
  };

  React.useEffect(function() {
    computeStyle();
    return function() { listenersRef.current.forEach(function(u) { u(); }); };
  }, deps || []);

  if (Object.keys(styleRef.current).length === 0) {
    try { styleRef.current = styleFactory(); } catch(e) { styleRef.current = {}; }
  }
  return styleRef.current;
}

function useAnimatedProps(f, d) { return useAnimatedStyle(f, d); }
function useAnimatedRef() { return React.useRef(null); }
// Tracks a scrollable ref's offset as a shared value. Used by the default Expo
// tabs template's ParallaxScrollView (import { useScrollViewOffset }). Missing
// it made the compiled call \`.useScrollViewOffset.call(void 0, ref)\` read
// 'call' off undefined and crash the whole screen.
function useScrollViewOffset(animatedRef) {
  var offset = useSharedValue(0);
  React.useEffect(function () {
    var node = animatedRef && animatedRef.current;
    if (!node) return undefined;
    var el = node && typeof node.getScrollableNode === 'function' ? node.getScrollableNode() : node;
    if (!el || typeof el.addEventListener !== 'function') return undefined;
    var handler = function () { offset.value = el.scrollTop || el.scrollY || 0; };
    handler();
    el.addEventListener('scroll', handler, { passive: true });
    return function () { el.removeEventListener('scroll', handler); };
  }, [animatedRef]);
  return offset;
}
function useDerivedValue(f, d) {
  var sv = useSharedValue(null);
  React.useEffect(function() { try { sv.value = f(); } catch(e) {} }, d || []);
  return sv;
}
function useAnimatedReaction(prep, react, d) {
  React.useEffect(function() { try { react(prep()); } catch(e) {} }, d || []);
}
function useAnimatedScrollHandler(handlers) {
  return function(event) {
    if (typeof handlers === "function") handlers(event);
    else if (handlers.onScroll) handlers.onScroll(event);
  };
}
function useAnimatedGestureHandler(handlers) {
  var ctxRef = React.useRef({});
  return React.useCallback(function(event) {
    var e = event.nativeEvent; var ctx = ctxRef.current;
    if (e.state === 2) { if (handlers.onStart) handlers.onStart(e, ctx); }
    else if (e.state === 4) { if (handlers.onActive) handlers.onActive(e, ctx); }
    else if (e.state === 5) { if (handlers.onEnd) handlers.onEnd(e, ctx); }
  }, [handlers]);
}
function useWorkletCallback(cb, d) { return React.useCallback(cb, d || []); }
function useFrameCallback(cb) {
  React.useEffect(function() {
    var id; var frame = function() { cb(); id = requestAnimationFrame(frame); };
    id = requestAnimationFrame(frame);
    return function() { cancelAnimationFrame(id); };
  }, [cb]);
}
function useAnimatedKeyboard() { return { height: useSharedValue(0), state: useSharedValue(0) }; }
function useAnimatedSensor() { return { sensor: useSharedValue({ x: 0, y: 0, z: 0 }) }; }

// Animation functions
function withTiming(toValue, config, callback) {
  return { __isAnimationDescriptor: true, type: "timing", toValue: toValue, config: config || {}, callback: callback };
}
function withSpring(toValue, config, callback) {
  return { __isAnimationDescriptor: true, type: "spring", toValue: toValue, config: config || {}, callback: callback };
}
function withDecay(config, callback) {
  var v = (config && config.velocity) || 0;
  var d = (config && config.deceleration) || 0.998;
  return v / (1 - d);
}
function withDelay(delayMs, animation) {
  return { __isAnimationDescriptor: true, type: "delay", delayMs: delayMs, inner: animation };
}
function withRepeat(animation, numberOfReps, reverse, callback) {
  return { __isAnimationDescriptor: true, type: "repeat", inner: animation, numberOfReps: numberOfReps || -1, reverse: !!reverse, callback: callback };
}
function withSequence() {
  var anims = Array.prototype.slice.call(arguments);
  return { __isAnimationDescriptor: true, type: "sequence", animations: anims };
}
function cancelAnimation(sv) {
  if (sv && sv._animationId !== null) {
    if (typeof sv._animationId === "number") cancelAnimationFrame(sv._animationId);
    else clearTimeout(sv._animationId);
    sv._animationId = null;
  }
}

// Easing
var Easing = {
  linear: function(t) { return t; },
  ease: function(t) { return t * t * (3 - 2 * t); },
  quad: function(t) { return t * t; },
  cubic: function(t) { return t * t * t; },
  poly: function(n) { return function(t) { return Math.pow(t, n); }; },
  sin: function(t) { return 1 - Math.cos(t * Math.PI / 2); },
  circle: function(t) { return 1 - Math.sqrt(1 - t * t); },
  exp: function(t) { return t === 0 ? 0 : Math.pow(2, 10 * (t - 1)); },
  elastic: function(b) { b = b || 1; return function(t) { var p = b * Math.PI; return 1 - Math.pow(Math.cos(t * Math.PI / 2), 3) * Math.cos(t * p); }; },
  back: function(s) { s = s || 1.70158; return function(t) { return t * t * ((s + 1) * t - s); }; },
  bounce: function(t) {
    if (t < 1/2.75) return 7.5625*t*t;
    if (t < 2/2.75) { t -= 1.5/2.75; return 7.5625*t*t + 0.75; }
    if (t < 2.5/2.75) { t -= 2.25/2.75; return 7.5625*t*t + 0.9375; }
    t -= 2.625/2.75; return 7.5625*t*t + 0.984375;
  },
  bezier: function(x1, y1, x2, y2) {
    return function(t) {
      var cx = 3*x1, bx = 3*(x2-x1)-cx, ax = 1-cx-bx;
      var cy = 3*y1, by = 3*(y2-y1)-cy, ay = 1-cy-by;
      var sx = function(t) { return ((ax*t+bx)*t+cx)*t; };
      var sy = function(t) { return ((ay*t+by)*t+cy)*t; };
      var solve = function(x) { var t2 = x; for (var i = 0; i < 8; i++) { var x2 = sx(t2)-x; if (Math.abs(x2)<0.001) break; var d2 = (3*ax*t2+2*bx)*t2+cx; if (Math.abs(d2)<0.000001) break; t2 -= x2/d2; } return t2; };
      return sy(solve(t));
    };
  },
  in: function(e) { return e; },
  out: function(e) { return function(t) { return 1 - e(1 - t); }; },
  inOut: function(e) { return function(t) { return t < 0.5 ? e(t*2)/2 : (2 - e(2 - t*2))/2; }; }
};

// Interpolation
var Extrapolate = { CLAMP: "clamp", EXTEND: "extend", IDENTITY: "identity" };
var Extrapolation = Extrapolate;

function interpolate(value, inputRange, outputRange, extrapolate) {
  extrapolate = extrapolate || Extrapolate.EXTEND;
  for (var i = 0; i < inputRange.length - 1; i++) {
    if (value >= inputRange[i] && value <= inputRange[i + 1]) {
      var ratio = (value - inputRange[i]) / (inputRange[i + 1] - inputRange[i]);
      return outputRange[i] + ratio * (outputRange[i + 1] - outputRange[i]);
    }
  }
  if (value < inputRange[0]) {
    if (extrapolate === "clamp") return outputRange[0];
    if (extrapolate === "identity") return value;
    var r = (value - inputRange[0]) / (inputRange[1] - inputRange[0]);
    return outputRange[0] + r * (outputRange[1] - outputRange[0]);
  }
  var last = inputRange.length - 1;
  if (extrapolate === "clamp") return outputRange[last];
  if (extrapolate === "identity") return value;
  var r2 = (value - inputRange[last]) / (inputRange[last] - inputRange[last - 1]);
  return outputRange[last] + r2 * (outputRange[last] - outputRange[last - 1]);
}

function interpolateColor(value, inputRange, outputRange) {
  return interpolate(value, inputRange, outputRange);
}

// Utility functions
function runOnJS(fn) { return function() { return fn.apply(null, arguments); }; }
function runOnUI(fn) { return function() { return fn.apply(null, arguments); }; }
function makeMutable(v) { return new SharedValue(v); }
function makeShareable(v) { return v; }
function processColor(c) { return c; }
function convertToRGBA(c) { return c; }
function measure() { return { x: 0, y: 0, width: 0, height: 0, pageX: 0, pageY: 0 }; }
function scrollTo() {}

// Animated components
function createAnimatedComponent(Component) {
  var Comp = React.forwardRef(function(props, ref) {
    var style = props.style; var animatedProps = props.animatedProps;
    var rest = Object.assign({}, props);
    delete rest.style; delete rest.animatedProps;
    var finalStyle = style && typeof style === "object" && style.value !== undefined ? style.value : style;
    return React.createElement(Component, Object.assign({}, rest, animatedProps || {}, { style: finalStyle, ref: ref }));
  });
  Comp.displayName = "Animated(" + (Component.displayName || Component.name || "Component") + ")";
  return Comp;
}

var AnimatedNS = {
  View: createAnimatedComponent(RN.View),
  Text: createAnimatedComponent(RN.Text),
  Image: createAnimatedComponent(RN.Image),
  ScrollView: createAnimatedComponent(RN.ScrollView),
  FlatList: createAnimatedComponent(RN.FlatList),
  createAnimatedComponent: createAnimatedComponent
};

// Layout animation stub
var LayoutStub = { duration: function() { return LayoutStub; }, delay: function() { return LayoutStub; }, springify: function() { return LayoutStub; }, damping: function() { return LayoutStub; }, mass: function() { return LayoutStub; }, stiffness: function() { return LayoutStub; }, overshootClamping: function() { return LayoutStub; }, restDisplacementThreshold: function() { return LayoutStub; }, restSpeedThreshold: function() { return LayoutStub; }, build: function() { return LayoutStub; } };

// Gesture stubs
var GestureDetector = function(props) { return React.createElement(RN.View, null, props.children); };
var Gesture = { Tap: function() { return {}; }, Pan: function() { return {}; }, Pinch: function() { return {}; }, Rotation: function() { return {}; }, Fling: function() { return {}; }, LongPress: function() { return {}; }, Race: function() { return {}; }, Simultaneous: function() { return {}; }, Exclusive: function() { return {}; } };

// Exports
exports.useSharedValue = useSharedValue;
exports.useAnimatedStyle = useAnimatedStyle;
exports.useAnimatedProps = useAnimatedProps;
exports.useAnimatedRef = useAnimatedRef;
exports.useScrollViewOffset = useScrollViewOffset;
exports.useScrollOffset = useScrollViewOffset;
exports.useDerivedValue = useDerivedValue;
exports.useAnimatedReaction = useAnimatedReaction;
exports.useAnimatedScrollHandler = useAnimatedScrollHandler;
exports.useAnimatedGestureHandler = useAnimatedGestureHandler;
exports.useWorkletCallback = useWorkletCallback;
exports.useFrameCallback = useFrameCallback;
exports.useAnimatedKeyboard = useAnimatedKeyboard;
exports.useAnimatedSensor = useAnimatedSensor;
exports.withTiming = withTiming;
exports.withSpring = withSpring;
exports.withDecay = withDecay;
exports.withDelay = withDelay;
exports.withRepeat = withRepeat;
exports.withSequence = withSequence;
exports.cancelAnimation = cancelAnimation;
exports.Easing = Easing;
exports.Extrapolate = Extrapolate;
exports.Extrapolation = Extrapolation;
exports.interpolate = interpolate;
exports.interpolateColor = interpolateColor;
exports.runOnJS = runOnJS;
exports.runOnUI = runOnUI;
exports.makeMutable = makeMutable;
exports.makeShareable = makeShareable;
exports.processColor = processColor;
exports.convertToRGBA = convertToRGBA;
exports.measure = measure;
exports.scrollTo = scrollTo;
exports.createAnimatedComponent = createAnimatedComponent;
exports.GestureDetector = GestureDetector;
exports.Gesture = Gesture;
exports.SharedTransition = { custom: function() { return {}; }, duration: function() { return {}; } };
exports.Layout = LayoutStub;
exports.FadeIn = LayoutStub; exports.FadeOut = LayoutStub;
exports.FadeInRight = LayoutStub; exports.FadeInLeft = LayoutStub;
exports.FadeInUp = LayoutStub; exports.FadeInDown = LayoutStub;
exports.FadeOutRight = LayoutStub; exports.FadeOutLeft = LayoutStub;
exports.FadeOutUp = LayoutStub; exports.FadeOutDown = LayoutStub;
exports.SlideInRight = LayoutStub; exports.SlideInLeft = LayoutStub;
exports.SlideInUp = LayoutStub; exports.SlideInDown = LayoutStub;
exports.SlideOutRight = LayoutStub; exports.SlideOutLeft = LayoutStub;
exports.SlideOutUp = LayoutStub; exports.SlideOutDown = LayoutStub;
exports.ZoomIn = LayoutStub; exports.ZoomOut = LayoutStub;
exports.BounceIn = LayoutStub; exports.BounceOut = LayoutStub;
exports.FlipInXUp = LayoutStub; exports.FlipInXDown = LayoutStub;
exports.FlipInYLeft = LayoutStub; exports.FlipInYRight = LayoutStub;
exports.FlipOutXUp = LayoutStub; exports.FlipOutXDown = LayoutStub;
exports.FlipOutYLeft = LayoutStub; exports.FlipOutYRight = LayoutStub;
exports.StretchInX = LayoutStub; exports.StretchInY = LayoutStub;
exports.StretchOutX = LayoutStub; exports.StretchOutY = LayoutStub;
exports.RotateInDownLeft = LayoutStub; exports.RotateInDownRight = LayoutStub;
exports.RotateInUpLeft = LayoutStub; exports.RotateInUpRight = LayoutStub;
exports.RotateOutDownLeft = LayoutStub; exports.RotateOutDownRight = LayoutStub;
exports.RotateOutUpLeft = LayoutStub; exports.RotateOutUpRight = LayoutStub;
exports.LightSpeedInRight = LayoutStub; exports.LightSpeedInLeft = LayoutStub;
exports.LightSpeedOutRight = LayoutStub; exports.LightSpeedOutLeft = LayoutStub;
exports.PinwheelIn = LayoutStub; exports.PinwheelOut = LayoutStub;
exports.RollInLeft = LayoutStub; exports.RollInRight = LayoutStub;
exports.RollOutLeft = LayoutStub; exports.RollOutRight = LayoutStub;
exports.Animated = AnimatedNS;
exports.default = Object.assign({}, AnimatedNS, exports);
exports.__esModule = true;
`;

/**
 * Shim for react-native-webview.
 * The real package wraps a native UIWebView/WKWebView/Android WebView which doesn't
 * exist in the browser. This shim renders an <iframe> wrapped in an RN View so flex
 * layout from RN parents continues to work.
 *
 * Supports `source.uri` and `source.html`, forwards a ref with best-effort imperative
 * methods (reload, goBack, goForward, injectJavaScript, postMessage), and bridges
 * onMessage via window 'message' events (only fires for same-origin / srcDoc).
 *
 * Injected via VFS + resolveRequest (not shimModules) to avoid changing the
 * dependency batch hash used for package prefetching, since react-native-webview
 * ships in the default scaffold package.json.
 */
export const WEBVIEW_SHIM = `
var React = require("react");
var RN = require("react-native");

var WebView = React.forwardRef(function WebView(props, ref) {
  var iframeRef = React.useRef(null);
  var src = props.source && props.source.uri ? props.source.uri : null;
  var html = props.source && props.source.html != null ? props.source.html : null;
  var injectedJS = props.injectedJavaScript;

  var srcDoc = null;
  if (html != null) {
    srcDoc = injectedJS ? html + "<script>" + injectedJS + "<\\/script>" : html;
  }

  React.useImperativeHandle(ref, function() {
    return {
      reload: function() { var f = iframeRef.current; if (f) { try { f.src = f.src; } catch(e) {} } },
      stopLoading: function() {},
      goBack: function() { var f = iframeRef.current; if (f && f.contentWindow) { try { f.contentWindow.history.back(); } catch(e) {} } },
      goForward: function() { var f = iframeRef.current; if (f && f.contentWindow) { try { f.contentWindow.history.forward(); } catch(e) {} } },
      injectJavaScript: function(script) {
        var f = iframeRef.current;
        if (f && f.contentWindow) { try { f.contentWindow.eval(script); } catch(e) {} }
      },
      postMessage: function(message) {
        var f = iframeRef.current;
        if (f && f.contentWindow) { try { f.contentWindow.postMessage(message, "*"); } catch(e) {} }
      },
      requestFocus: function() { var f = iframeRef.current; if (f && f.contentWindow) { try { f.contentWindow.focus(); } catch(e) {} } },
      clearCache: function() {},
      clearHistory: function() {},
      clearFormData: function() {}
    };
  }, []);

  React.useEffect(function() {
    if (!props.onMessage || typeof window === "undefined") return;
    var handler = function(event) {
      if (iframeRef.current && event.source === iframeRef.current.contentWindow) {
        props.onMessage({ nativeEvent: { data: event.data, url: src || "" } });
      }
    };
    window.addEventListener("message", handler);
    return function() { window.removeEventListener("message", handler); };
  }, [props.onMessage, src]);

  React.useEffect(function() {
    if (props.onLoadStart) props.onLoadStart({ nativeEvent: { url: src || "" } });
  }, []);

  var flat = (RN.StyleSheet && RN.StyleSheet.flatten) ? RN.StyleSheet.flatten(props.style) : props.style;
  var containerStyle = Object.assign({ flex: 1, overflow: "hidden" }, flat || {});

  var iframeProps = {
    ref: iframeRef,
    style: { width: "100%", height: "100%", border: "none", backgroundColor: containerStyle.backgroundColor || "transparent" },
    title: props.testID || "react-native-webview",
    sandbox: props.sandbox || "allow-scripts allow-same-origin allow-forms allow-popups allow-presentation allow-modals",
    referrerPolicy: "no-referrer-when-downgrade",
    allow: "fullscreen; camera; microphone; geolocation; clipboard-read; clipboard-write",
    allowFullScreen: true,
    onLoad: function() {
      if (props.onLoad) props.onLoad({ nativeEvent: { url: src || "" } });
      if (props.onLoadEnd) props.onLoadEnd({ nativeEvent: { url: src || "" } });
      if (props.onNavigationStateChange) props.onNavigationStateChange({ url: src || "", title: "", loading: false, canGoBack: false, canGoForward: false });
    },
    onError: function() {
      if (props.onError) props.onError({ nativeEvent: { description: "iframe failed to load", url: src || "" } });
      if (props.onLoadEnd) props.onLoadEnd({ nativeEvent: { url: src || "" } });
    }
  };
  if (srcDoc != null) iframeProps.srcDoc = srcDoc;
  else if (src) iframeProps.src = src;

  return React.createElement(RN.View, { style: containerStyle },
    React.createElement("iframe", iframeProps)
  );
});

WebView.displayName = "WebView";

exports.WebView = WebView;
exports.default = WebView;
exports.__esModule = true;
`;
