/* Group existing admin links without changing routing or permission checks. */
(() => {
  const nav = document.getElementById('adminTabBar');
  if (!nav?.classList.contains('grouped-nav')) return;
  const groups = [...nav.querySelectorAll('.admin-nav-group')];
  let openGroup = null, closeTimer, hoverOpened = false;
  const linksFor = group => [...group.querySelectorAll('.admin-tab')].filter(link => !link.hidden && link.style.display !== 'none');
  function close() {
    clearTimeout(closeTimer);
    if (!openGroup) return;
    openGroup.classList.remove('is-open');
    openGroup.querySelector('button').setAttribute('aria-expanded', 'false');
    openGroup.querySelector('.admin-nav-menu').hidden = true;
    openGroup = null;
  }
  function open(group, focus = false, last = false, hover = false) {
    clearTimeout(closeTimer);
    if (openGroup !== group) close();
    openGroup = group;
    hoverOpened = hover;
    group.classList.add('is-open');
    const menu = group.querySelector('.admin-nav-menu');
    menu.hidden = false;
    group.querySelector('button').setAttribute('aria-expanded', 'true');
    menu.style.removeProperty('--menu-shift');
    if (matchMedia('(min-width:761px)').matches) {
      const rect = menu.getBoundingClientRect();
      const shift = Math.min(0, window.innerWidth - 16 - rect.right);
      if (shift) menu.style.setProperty('--menu-shift', shift + 'px');
    }
    if (focus) { const links = linksFor(group); (last ? links.at(-1) : links[0])?.focus(); }
  }
  for (const group of groups) {
    const trigger = group.querySelector('button');
    trigger.addEventListener('click', event => {
      if (openGroup === group && !hoverOpened) close(); else open(group, event.detail === 0);
    });
    trigger.addEventListener('keydown', event => {
      if (!['ArrowDown','ArrowUp'].includes(event.key)) return;
      event.preventDefault(); open(group, true, event.key === 'ArrowUp');
    });
    group.addEventListener('pointerenter', event => {
      if (event.pointerType !== 'mouse') return;
      if (openGroup !== group) open(group, false, false, true); else clearTimeout(closeTimer);
    });
    group.addEventListener('pointerleave', event => {
      if (event.pointerType === 'mouse') closeTimer = setTimeout(() => {
        if (openGroup === group && !group.querySelector('.admin-nav-menu').contains(document.activeElement)) close();
      }, 160);
    });
    group.addEventListener('focusout', () => setTimeout(() => { if (openGroup === group && !group.contains(document.activeElement)) close(); }, 0));
    group.querySelector('.admin-nav-menu').addEventListener('keydown', event => {
      if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
      const links = linksFor(group), current = links.indexOf(document.activeElement);
      if (!links.length) return;
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? links.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
      links[index].focus();
    });
  }
  nav.addEventListener('keydown', event => {
    if (event.key === 'Escape' && openGroup) { const trigger = openGroup.querySelector('button'); close(); trigger.focus(); event.preventDefault(); }
  });
  nav.addEventListener('click', event => { if (event.target.closest('.admin-tab')) close(); });
  document.addEventListener('pointerdown', event => { if (!nav.contains(event.target)) close(); });
  window.addEventListener('resize', close);
  function sync() {
    for (const group of groups) {
      const links = linksFor(group);
      group.hidden = !links.length;
      if (group.hidden && openGroup === group) close();
      group.classList.toggle('has-active', links.some(link => link.classList.contains('active')));
      for (const link of group.querySelectorAll('.admin-tab')) {
        if (link.classList.contains('active')) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
      }
      const count = links.reduce((total, link) => total + [...link.querySelectorAll('span[id]')].reduce((n, badge) => n + (badge.style.display !== 'none' && !badge.hidden ? parseInt(badge.textContent, 10) || 0 : 0), 0), 0);
      const badge = group.querySelector('.admin-group-count');
      badge.hidden = count === 0;
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.setAttribute('aria-label', count + ' notifications');
      // Don't leave an orphan separator when staff permissions hide a section.
      const divider = group.querySelector('.admin-menu-divider');
      if (divider) {
        const children = [...divider.parentElement.children], at = children.indexOf(divider);
        divider.hidden = !children.slice(0, at).some(el => links.includes(el)) || !children.slice(at + 1).some(el => links.includes(el));
      }
    }
  }
  // Watch original links only: updating group badges must not trigger a loop.
  const observer = new MutationObserver(sync);
  nav.querySelectorAll('.admin-tab').forEach(link => observer.observe(link, {subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden']}));
  sync();
})();
