// Shared flow-control sentinels. In their own module so app.js and
// precision.js can both import them without a circular import — a cycle back
// into 'app.js' would double-load the module (index.html loads it as
// 'app.js?v=N', a different URL) and construct a second app instance.
export const RETAKE = Symbol('retake');
export const HOME = Symbol('home');
