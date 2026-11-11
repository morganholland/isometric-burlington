// Anonymous product analytics (PostHog, project "Isometric Burlington").
// Only the live site reports: localhost, tests and preview deploys stay silent.
// No cookies (localStorage only), no autocapture, no session replay, and never
// what people type into search.
const KEY = 'phc_C8Q757FTA7XJb2cyY2DyeW5sxhniMDep2DuXKUWLBukc'; // public project token, safe in client code
const LIVE_HOSTS = ['isoburlington.com', 'www.isoburlington.com'];

// every event is also kept here so tests (and curious people) can see what would be sent
const log = (window.__isoEvents = []);
let live = false;

export function initTracking(host = location.hostname) {
  if (!LIVE_HOSTS.includes(host)) return false;
  // PostHog's standard loader stub: queues calls until array.js arrives
  /* eslint-disable */
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  /* eslint-enable */
  window.posthog.init(KEY, {
    api_host: 'https://us.i.posthog.com',
    persistence: 'localStorage',
    person_profiles: 'identified_only',
    autocapture: false,
    capture_pageview: true,
    capture_pageleave: true,
    disable_session_recording: true,
  });
  live = true;
  return true;
}

export function track(event, props = {}) {
  log.push({ event, props });
  // look posthog up on every call: the loader swaps the stub for the real client once it arrives
  if (live) try { window.posthog.capture(event, props); } catch {}
}
