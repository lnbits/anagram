// Invitation data stays in the fragment. Only navigate to known app routes.
const fragment = window.location.hash;
const callPage = /\/join\/call(?:\.html)?\/?$/.test(window.location.pathname);
const chatPage = /\/join\/chat(?:\.html)?\/?$/.test(window.location.pathname);
let target = '';
if (callPage && /^#\/call\/[A-Za-z0-9_-]{1,8192}$/.test(fragment)) {
  target = '/' + fragment;
} else if (chatPage && /^#\/public\/naddr1[023456789acdefghjklmnpqrstuvwxyz]{1,5000}$/.test(fragment)) {
  target = fragment.slice(1);
}
if (target) {
  document.getElementById('open-anagram').href = target;
  window.location.replace(target);
}
