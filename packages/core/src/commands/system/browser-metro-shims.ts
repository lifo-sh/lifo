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
// suffix). Mirrors React DOM's internal list, EXCEPT lineHeight: CSS allows
// unitless line-height (a font-size multiplier) but RN/react-native-web
// treat numeric lineHeight as pixels, so it must get a px suffix here.
// Used when applying user style via element.style[k] = v in a ref
// callback — numeric values for any other key default to pixels (RN
// convention).
var _UNITLESS = {
  animationIterationCount: true, aspectRatio: true, borderImageOutset: true,
  borderImageSlice: true, borderImageWidth: true, boxFlex: true,
  boxFlexGroup: true, boxOrdinalGroup: true, columnCount: true, columns: true,
  flex: true, flexGrow: true, flexPositive: true, flexShrink: true,
  flexNegative: true, flexOrder: true, gridArea: true, gridRow: true,
  gridRowEnd: true, gridRowSpan: true, gridRowStart: true, gridColumn: true,
  gridColumnEnd: true, gridColumnSpan: true, gridColumnStart: true,
  fontWeight: true, lineClamp: true, opacity: true,
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

// Remap className props used by RN list components (FlatList, ScrollView)
// to their corresponding style props with $$css objects.
var _REMAP_CLASSNAME = {
  contentContainerClassName: "contentContainerStyle",
  columnWrapperClassName: "columnWrapperStyle",
  ListHeaderComponentClassName: "ListHeaderComponentStyle",
  ListFooterComponentClassName: "ListFooterComponentStyle",
};

function _classNameToCss(cn) {
  var obj = { $$css: true };
  cn.split(/\\s+/).forEach(function(c) { if (c) obj[c] = c; });
  return obj;
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

  var remapKeys = null;
  for (var _rk in _REMAP_CLASSNAME) {
    if (typeof props[_rk] === "string" && props[_rk]) {
      (remapKeys || (remapKeys = [])).push(_rk);
    }
  }

  if (!className && !cssVars && !remapKeys) {
    return _orig.apply(this, args);
  }

  props = Object.assign({}, props);

  if (remapKeys) {
    for (var _ri = 0; _ri < remapKeys.length; _ri++) {
      var _rkey = remapKeys[_ri];
      var _skey = _REMAP_CLASSNAME[_rkey];
      var _rcss = _classNameToCss(props[_rkey]);
      var _existing = props[_skey];
      if (Array.isArray(_existing)) props[_skey] = [_rcss].concat(_existing);
      else if (_existing) props[_skey] = [_rcss, _existing];
      else props[_skey] = _rcss;
      delete props[_rkey];
    }
  }
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
    if (cleanedStyle.$$css === true) {
      // The style is itself a $$css token object — a parent component's
      // converted className forwarded through {...rest} (e.g. a Surface
      // wrapper spreading caller props onto its inner View). Merge the two
      // token sets into ONE $$css object; the defer-to-ref path below would
      // write tokens like el.style["gap-3"] = "gap-3" — invalid CSS
      // properties, silently dropped — and the caller's classes would vanish.
      // Caller tokens go last, mirroring cn(base, className) precedence.
      props.style = Object.assign({}, cssObj, cleanedStyle);
    } else {
      // Plain object: defer to ref only if it has any real keys. An empty
      // object (often the post-_stripUndefined shape of a buggy user style)
      // collapses to just cssObj — same as having no user style at all.
      if (Object.keys(cleanedStyle).length > 0) {
        deferredUserStyle = cleanedStyle;
      }
      props.style = cssObj;
    }
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
/**
 * Shim for react-native-gesture-handler.
 * Provides GestureHandlerRootView (passthrough View), Gesture factories,
 * GestureDetector, Swipeable, and all commonly imported gesture types/hooks
 * so projects using gesture-handler don't crash in the browser preview.
 */
export const GESTURE_HANDLER_SHIM = `
var React = require("react");
var RN = require("react-native");

// GestureHandlerRootView — just a plain View wrapper
var GestureHandlerRootView = React.forwardRef(function(props, ref) {
  return React.createElement(RN.View, Object.assign({}, props, { ref: ref }));
});
GestureHandlerRootView.displayName = "GestureHandlerRootView";

// Gesture factories — return chainable builder objects
function makeGestureBuilder() {
  var g = {
    enabled: function() { return g; },
    minDistance: function() { return g; },
    minPointers: function() { return g; },
    maxPointers: function() { return g; },
    minVelocity: function() { return g; },
    minVelocityX: function() { return g; },
    minVelocityY: function() { return g; },
    activeOffsetX: function() { return g; },
    activeOffsetY: function() { return g; },
    failOffsetX: function() { return g; },
    failOffsetY: function() { return g; },
    numberOfTaps: function() { return g; },
    maxDuration: function() { return g; },
    maxDelay: function() { return g; },
    maxDist: function() { return g; },
    minDurationMs: function() { return g; },
    shouldCancelWhenOutside: function() { return g; },
    hitSlop: function() { return g; },
    simultaneousWithExternalGesture: function() { return g; },
    requireExternalGestureToFail: function() { return g; },
    blocksExternalGesture: function() { return g; },
    withRef: function() { return g; },
    withTestId: function() { return g; },
    runOnJS: function() { return g; },
    onBegin: function() { return g; },
    onStart: function() { return g; },
    onUpdate: function() { return g; },
    onChange: function() { return g; },
    onEnd: function() { return g; },
    onFinalize: function() { return g; },
    onTouchesDown: function() { return g; },
    onTouchesMove: function() { return g; },
    onTouchesUp: function() { return g; },
    onTouchesCancelled: function() { return g; },
    initialize: function() { return g; },
    toGestureArray: function() { return [g]; },
    prepare: function() {},
  };
  return g;
}

var Gesture = {
  Tap: function() { return makeGestureBuilder(); },
  Pan: function() { return makeGestureBuilder(); },
  Pinch: function() { return makeGestureBuilder(); },
  Rotation: function() { return makeGestureBuilder(); },
  Fling: function() { return makeGestureBuilder(); },
  LongPress: function() { return makeGestureBuilder(); },
  ForceTouch: function() { return makeGestureBuilder(); },
  Native: function() { return makeGestureBuilder(); },
  Manual: function() { return makeGestureBuilder(); },
  Hover: function() { return makeGestureBuilder(); },
  Race: function() { return makeGestureBuilder(); },
  Simultaneous: function() { return makeGestureBuilder(); },
  Exclusive: function() { return makeGestureBuilder(); },
};

// GestureDetector — renders children as-is (gestures are no-ops in preview)
function GestureDetector(props) {
  return props.children || null;
}
GestureDetector.displayName = "GestureDetector";

// Legacy gesture handler components (class-based API)
function makeGestureComponent(name) {
  var C = React.forwardRef(function(props, ref) {
    return React.createElement(RN.View, Object.assign({}, props, { ref: ref }));
  });
  C.displayName = name;
  return C;
}

var TapGestureHandler = makeGestureComponent("TapGestureHandler");
var PanGestureHandler = makeGestureComponent("PanGestureHandler");
var PinchGestureHandler = makeGestureComponent("PinchGestureHandler");
var RotationGestureHandler = makeGestureComponent("RotationGestureHandler");
var FlingGestureHandler = makeGestureComponent("FlingGestureHandler");
var LongPressGestureHandler = makeGestureComponent("LongPressGestureHandler");
var ForceTouchGestureHandler = makeGestureComponent("ForceTouchGestureHandler");
var NativeViewGestureHandler = makeGestureComponent("NativeViewGestureHandler");

// Swipeable component — renders children, passes through swipe actions
var Swipeable = React.forwardRef(function(props, ref) {
  return React.createElement(RN.View, { ref: ref, style: props.containerStyle },
    props.children
  );
});
Swipeable.displayName = "Swipeable";

// DrawerLayout — renders children
var DrawerLayout = React.forwardRef(function(props, ref) {
  return React.createElement(RN.View, { ref: ref, style: { flex: 1 } },
    props.children
  );
});
DrawerLayout.displayName = "DrawerLayout";

// RN component wrappers (pass-through)
var ScrollView = RN.ScrollView;
var FlatList = RN.FlatList;
var Switch = RN.Switch;
var TextInput = RN.TextInput;
var TouchableOpacity = RN.TouchableOpacity;
var TouchableHighlight = RN.TouchableHighlight;
var TouchableWithoutFeedback = RN.TouchableWithoutFeedback;
var TouchableNativeFeedback = RN.TouchableOpacity;

// State enum
var State = { UNDETERMINED: 0, FAILED: 1, BEGAN: 2, CANCELLED: 3, ACTIVE: 4, END: 5 };

// Direction flags
var Directions = { RIGHT: 1, LEFT: 2, UP: 4, DOWN: 8 };

// Gesture type (dummy)
function gestureHandlerRootHOC(Component) { return Component; }

exports.GestureHandlerRootView = GestureHandlerRootView;
exports.Gesture = Gesture;
exports.GestureDetector = GestureDetector;
exports.TapGestureHandler = TapGestureHandler;
exports.PanGestureHandler = PanGestureHandler;
exports.PinchGestureHandler = PinchGestureHandler;
exports.RotationGestureHandler = RotationGestureHandler;
exports.FlingGestureHandler = FlingGestureHandler;
exports.LongPressGestureHandler = LongPressGestureHandler;
exports.ForceTouchGestureHandler = ForceTouchGestureHandler;
exports.NativeViewGestureHandler = NativeViewGestureHandler;
exports.Swipeable = Swipeable;
exports.DrawerLayout = DrawerLayout;
exports.ScrollView = ScrollView;
exports.FlatList = FlatList;
exports.Switch = Switch;
exports.TextInput = TextInput;
exports.TouchableOpacity = TouchableOpacity;
exports.TouchableHighlight = TouchableHighlight;
exports.TouchableWithoutFeedback = TouchableWithoutFeedback;
exports.TouchableNativeFeedback = TouchableNativeFeedback;
exports.State = State;
exports.Directions = Directions;
exports.gestureHandlerRootHOC = gestureHandlerRootHOC;
exports.createNativeWrapper = function(C) { return C; };
exports.default = { GestureHandlerRootView: GestureHandlerRootView };
exports.__esModule = true;
`;

// ---------------------------------------------------------------------------
// Editor scripts — injected into the preview HTML <head> for IDE integration.
// These run before the bundle loads so they can intercept errors early.
// ---------------------------------------------------------------------------

/**
 * Console interception — forwards console.* calls to the parent editor window
 * via postMessage so the editor can display them in its console panel.
 */
export const CONSOLE_INTERCEPT_SCRIPT =
  "['log','warn','error','info'].forEach(function(method) {\n" +
  '  var orig = console[method];\n' +
  '  console[method] = function() {\n' +
  '    var args = Array.prototype.slice.call(arguments);\n' +
  '    var text = args.map(function(a) {\n' +
  "      if (typeof a === 'object') try { return JSON.stringify(a); } catch(e) { return String(a); }\n" +
  '      return String(a);\n' +
  "    }).join(' ');\n" +
  "    if (window.parent) window.parent.postMessage({ type: 'console', method: method, text: text }, '*');\n" +
  '    if (orig) orig.apply(console, arguments);\n' +
  '  };\n' +
  '});\n';

/**
 * Source map resolver + runtime error handlers.
 * Decodes inline source maps (VLQ base64), resolves generated line/col back to
 * original file, and posts structured runtime errors to the parent editor.
 * Also listens for HMR updates to extract per-module source maps.
 */
export const SM_RESOLVER_AND_ERROR_HANDLERS =
  '(function() {\n' +
  "var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';\n" +
  'var B64D = {};\n' +
  'for (var i = 0; i < B64.length; i++) B64D[B64[i]] = i;\n' +
  'function decodeVLQ(str, offset) {\n' +
  '  var result = 0, shift = 0, cont, idx = offset;\n' +
  '  do { var d = B64D[str[idx++]]; cont = (d & 32) !== 0; result += (d & 31) << shift; shift += 5; } while (cont);\n' +
  '  return { value: (result & 1) ? -(result >> 1) : (result >> 1), next: idx };\n' +
  '}\n' +
  'function decodeMappings(mappings) {\n' +
  '  var lines = [], srcIdx = 0, origLine = 0, origCol = 0;\n' +
  "  var parts = mappings.split(';');\n" +
  '  for (var li = 0; li < parts.length; li++) {\n' +
  '    var segs = [], genCol = 0, lineStr = parts[li];\n' +
  '    if (lineStr) {\n' +
  "      var segParts = lineStr.split(',');\n" +
  '      for (var si = 0; si < segParts.length; si++) {\n' +
  '        var s = segParts[si]; if (!s) continue;\n' +
  '        var pos = 0, f = [];\n' +
  '        while (pos < s.length) { var r = decodeVLQ(s, pos); f.push(r.value); pos = r.next; }\n' +
  '        if (f.length >= 4) { genCol += f[0]; srcIdx += f[1]; origLine += f[2]; origCol += f[3]; segs.push([genCol, srcIdx, origLine, origCol]); }\n' +
  '        else if (f.length >= 1) { genCol += f[0]; segs.push([genCol]); }\n' +
  '      }\n' +
  '    }\n' +
  '    lines.push(segs);\n' +
  '  }\n' +
  '  return lines;\n' +
  '}\n' +
  'var maps = {};\n' +
  'function addMap(url, mapData) { maps[url] = { sources: mapData.sources, decoded: decodeMappings(mapData.mappings) }; }\n' +
  'function resolve(url, line, col) {\n' +
  '  var m = maps[url]; if (!m) return null;\n' +
  '  var decoded = m.decoded; if (line < 0 || line >= decoded.length) return null;\n' +
  '  var segs = decoded[line]; if (!segs || segs.length === 0) return null;\n' +
  '  var best = null;\n' +
  '  for (var i = 0; i < segs.length; i++) { var seg = segs[i]; if (seg.length < 4) continue; if (seg[0] <= col) best = seg; }\n' +
  '  if (!best) { for (var j = 0; j < segs.length; j++) { if (segs[j].length >= 4) { best = segs[j]; break; } } }\n' +
  '  if (!best) return null;\n' +
  "  return { file: m.sources[best[1]] || '(unknown)', line: best[2] + 1, column: best[3] + 1 };\n" +
  '}\n' +
  "function extractInlineSM(code) {\n" +
  "  var marker = '//# sourceMappingURL=data:application/json;base64,';\n" +
  '  var idx = code.lastIndexOf(marker); if (idx === -1) return null;\n' +
  "  var start = idx + marker.length; var end = code.indexOf('\\n', start); if (end === -1) end = code.length;\n" +
  '  try { return JSON.parse(atob(code.slice(start, end).trim())); } catch(e) { return null; }\n' +
  '}\n' +
  "function extractSourceURL(code) {\n" +
  "  var marker = '//# sourceURL='; var idx = code.lastIndexOf(marker); if (idx === -1) return null;\n" +
  "  var start = idx + marker.length; var end = code.indexOf('\\n', start); if (end === -1) end = code.length;\n" +
  '  return code.slice(start, end).trim();\n' +
  '}\n' +
  'window.__SM = { init: function(url, mapData) { addMap(url, mapData); }, add: function(url, mapData) { addMap(url, mapData); }, resolve: resolve };\n' +
  "window.addEventListener('message', function(e) {\n" +
  "  if (!e.data || e.data.type !== 'hmr-update') return;\n" +
  '  __runtimeErrorPosted = false;\n' +
  '  var mods = e.data.updatedModules; if (!mods) return;\n' +
  '  for (var key in mods) {\n' +
  "    var code = mods[key]; if (typeof code !== 'string') continue;\n" +
  '    var sm = extractInlineSM(code); var sourceURL = extractSourceURL(code);\n' +
  '    if (sm && sourceURL) window.__SM.add(sourceURL, sm);\n' +
  '  }\n' +
  '});\n' +
  'function parseStack(stack) {\n' +
  '  if (!stack) return [];\n' +
  '  var frames = [];\n' +
  "  var lines = stack.split('\\n');\n" +
  '  for (var i = 0; i < lines.length; i++) {\n' +
  '    var line = lines[i].trim();\n' +
  '    var m = line.match(/^at\\s+(.+?)\\s+\\((.+?):(\\d+):(\\d+)\\)$/);\n' +
  '    if (m) { frames.push({ fn: m[1], file: m[2], line: parseInt(m[3],10), column: parseInt(m[4],10) }); continue; }\n' +
  '    m = line.match(/^at\\s+(.+?):(\\d+):(\\d+)$/);\n' +
  "    if (m) { frames.push({ fn: '(anonymous)', file: m[1], line: parseInt(m[2],10), column: parseInt(m[3],10) }); }\n" +
  '  }\n' +
  '  return frames;\n' +
  '}\n' +
  'var __runtimeErrorPosted = false;\n' +
  'function postRuntimeError(message, stack) {\n' +
  '  if (__runtimeErrorPosted) return;\n' +
  '  __runtimeErrorPosted = true;\n' +
  '  var resolved = null;\n' +
  '  if (stack) {\n' +
  '    var frames = parseStack(stack);\n' +
  '    for (var i = 0; i < frames.length; i++) {\n' +
  '      var f = frames[i]; var r = resolve(f.file, f.line - 1, f.column - 1);\n' +
  "      if (r && r.file && r.file.indexOf('blob:') === -1) { resolved = r; break; }\n" +
  '    }\n' +
  '  }\n' +
  "  var msg = String(message).replace(/^Uncaught\\s+(Error:\\s*)?/, '');\n" +
  "  var fullMsg = resolved && resolved.file ? resolved.file + ':' + resolved.line + '\\n' + msg : msg;\n" +
  '  if (!window.parent) return;\n' +
  "  window.parent.postMessage({ type: 'iframe.error.runtime', payload: {\n" +
  "    message: fullMsg, errorType: 'runtime-error', source: 'runtime',\n" +
  "    path: (resolved && resolved.file) || '', line: resolved ? resolved.line : null, column: resolved ? resolved.column : null\n" +
  "  }}, '*');\n" +
  '}\n' +
  'window.onerror = function(msg, src, line, col, err) { postRuntimeError(msg, err && err.stack); return false; };\n' +
  "window.addEventListener('unhandledrejection', function(e) {\n" +
  "  var r = e.reason; postRuntimeError(r instanceof Error ? r.message : String(r || 'Unhandled rejection'), r && r.stack);\n" +
  '});\n' +
  '})();\n';

/**
 * Layer selection + pinch zoom — injected into every preview iframe.
 *
 * Layer selection: traverses React Fiber nodes to find data-bx-path attributes,
 * posts hoverElement/selectLayer messages to parent on mousemove/mouseup.
 * Supports inspect mode (blocks clicks/taps, only sends selection events).
 *
 * Pinch zoom: Ctrl+Wheel (desktop) and two-finger touch (mobile) send
 * pinchZoom messages to parent with phase, scale, and center coordinates.
 * Throttled to 16ms to prevent excessive postMessage calls.
 */
export const LAYER_SELECTION_SCRIPT = `(function() {
  function getFiberFromDOMNode(el) {
    if (!el) return null;
    var key = Object.keys(el).find(function(k) {
      return k.startsWith('__reactFiber$') ||
             k.startsWith('__reactContainer$') ||
             k.startsWith('__reactInternalInstance$');
    });
    return key ? el[key] : null;
  }

  function getBxPath(fiber) {
    while (fiber) {
      var props = fiber.memoizedProps;
      if (props) {
        var p = props['data-bx-path'] || (props.dataSet && props.dataSet['bx-path']);
        if (p) return p;
      }
      fiber = fiber.return;
    }
    return null;
  }

  function toFileKey(vfsPath) {
    return vfsPath.startsWith('/') ? vfsPath.slice(1) : vfsPath;
  }

  var inspectMode = false;

  window.addEventListener('mousemove', function(e) {
    var target = e.target;
    if (!target) return;
    var bxPath = getBxPath(getFiberFromDOMNode(target));
    if (!bxPath) return;
    var rect = target.getBoundingClientRect();
    window.parent.postMessage({
      type: 'hoverElement',
      payload: {
        path: bxPath,
        filePath: toFileKey(bxPath.split(':')[0]),
        x: rect.left, y: rect.top, width: rect.width, height: rect.height
      }
    }, '*');
  });

  window.addEventListener('mouseup', function(e) {
    var target = e.target;
    if (!target) return;
    var bxPath = getBxPath(getFiberFromDOMNode(target));
    if (!bxPath) return;
    var rect = target.getBoundingClientRect();
    window.parent.postMessage({
      type: 'selectLayer',
      payload: {
        path: bxPath,
        filePath: toFileKey(bxPath.split(':')[0]),
        x: rect.left, y: rect.top, width: rect.width, height: rect.height
      }
    }, '*');
  });

  function blockPropagationOnly(e) {
    if (!inspectMode) return;
    if (e.touches && e.touches.length > 1) return;
    e.stopPropagation();
  }
  ['pointerdown', 'mousedown', 'touchstart'].forEach(function(type) {
    window.addEventListener(type, blockPropagationOnly, true);
  });

  function blockActionEvent(e) {
    if (!inspectMode) return;
    e.preventDefault();
    e.stopPropagation();
  }
  ['click', 'dblclick', 'auxclick', 'contextmenu', 'submit'].forEach(function(type) {
    window.addEventListener(type, blockActionEvent, true);
  });

  var artboardX = 0;
  var artboardY = 0;
  var artboardId = '';

  window.addEventListener('message', function(e) {
    if (!e.data) return;
    if (e.data.type === 'setInspectMode') {
      inspectMode = !!e.data.value;
    }
    if (e.data.type === 'setArtboardPosition') {
      artboardX = e.data.x || 0;
      artboardY = e.data.y || 0;
    }
    if (e.data.type === 'setArtboardId' && e.data.id) {
      artboardId = e.data.id;
      window.parent.postMessage({ type: 'artboardIdSet', id: artboardId }, '*');
    }
  });

  window.parent.postMessage({ type: 'requestArtboardPosition' }, '*');

  var lastPinchSend = 0;
  var THROTTLE_MS = 16;

  function sendPinchZoom(payload) {
    var now = Date.now();
    if (now - lastPinchSend < THROTTLE_MS) return;
    lastPinchSend = now;
    payload.artboardX = artboardX;
    payload.artboardY = artboardY;
    payload.artboardId = artboardId;
    window.parent.postMessage({ type: 'pinchZoom', payload: payload }, '*');
  }

  window.addEventListener('wheel', function(e) {
    if (e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      sendPinchZoom({
        phase: 'wheel',
        deltaY: e.deltaY,
        centerX: e.clientX,
        centerY: e.clientY
      });
    }
  }, { passive: false });

  var pinchStartDistance = 0;
  var lastPinchDistance = 0;

  function getTouchDistance(t1, t2) {
    var dx = t1.clientX - t2.clientX;
    var dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function getTouchCenter(t1, t2) {
    return {
      x: (t1.clientX + t2.clientX) / 2,
      y: (t1.clientY + t2.clientY) / 2
    };
  }

  window.addEventListener('touchstart', function(e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      pinchStartDistance = getTouchDistance(e.touches[0], e.touches[1]);
      lastPinchDistance = pinchStartDistance;
      var center = getTouchCenter(e.touches[0], e.touches[1]);
      sendPinchZoom({ phase: 'start', centerX: center.x, centerY: center.y });
    }
  }, { passive: false });

  window.addEventListener('touchmove', function(e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      var currentDistance = getTouchDistance(e.touches[0], e.touches[1]);
      var scale = currentDistance / lastPinchDistance;
      lastPinchDistance = currentDistance;
      var center = getTouchCenter(e.touches[0], e.touches[1]);
      sendPinchZoom({ phase: 'move', scale: scale, centerX: center.x, centerY: center.y });
    }
  }, { passive: false });

  window.addEventListener('touchend', function(e) {
    if (e.touches.length < 2 && pinchStartDistance > 0) {
      pinchStartDistance = 0;
      lastPinchDistance = 0;
      sendPinchZoom({ phase: 'end' });
    }
  }, { passive: false });

  window.addEventListener('gesturestart', function(e) { e.preventDefault(); });
  window.addEventListener('gesturechange', function(e) { e.preventDefault(); });
  window.addEventListener('gestureend', function(e) { e.preventDefault(); });
})();`;

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
