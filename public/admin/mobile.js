/* Reuse the existing navigation actions and role visibility on small screens. */
(() => {
  const tabs = document.getElementById('adminTabBar');
  if (!tabs || tabs.classList.contains('grouped-nav')) return;
  const picker = document.createElement('div');
  picker.className = 'mobile-section-picker';
  picker.hidden = true;
  const label = document.createElement('label');
  label.htmlFor = 'mobileAdminSection';
  label.textContent = 'Admin section';
  const select = document.createElement('select');
  select.id = 'mobileAdminSection';
  picker.append(label, select);
  tabs.before(picker);

  function syncNavigation() {
    picker.hidden = tabs.style.display === 'none';
    const buttons = [...tabs.querySelectorAll('.admin-tab')];
    const visible = buttons.filter(button => !button.hidden && button.style.display !== 'none');
    const options = visible.map(button => new Option(button.textContent.trim().replace(/\s+/g, ' '), button.dataset.tab));
    select.replaceChildren(...options);
    const active = visible.find(button => button.classList.contains('active'));
    if (active) select.value = active.dataset.tab;
    if (!tabs.classList.contains('mobile-picker-ready')) tabs.classList.add('mobile-picker-ready');
  }
  select.addEventListener('change', () => {
    const button = [...tabs.querySelectorAll('.admin-tab')].find(button => button.dataset.tab === select.value);
    if (button && button.style.display !== 'none') button.click();
  });
  // Existing code changes classes for tabs, styles for staff roles and text for badges.
  new MutationObserver(syncNavigation).observe(tabs, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['class', 'style', 'hidden']
  });
  syncNavigation();
})();
