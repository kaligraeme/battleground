// Applies the saved theme before first paint, so a light-theme user never sees a dark flash.
// Loaded as a separate file because the server's Content-Security-Policy forbids inline scripts.
try {
  var t = localStorage.getItem('battleground.theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) {}
