// Run before the stylesheet and app so a saved dark preference never flashes white.
(() => {
  let theme = 'light';
  try { if (localStorage.getItem('jimeng-manager-theme') === 'dark') theme = 'dark'; } catch {}
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.style.backgroundColor = theme === 'dark' ? '#101722' : '#f5f7fa';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101722' : '#f5f7fa');
})();
