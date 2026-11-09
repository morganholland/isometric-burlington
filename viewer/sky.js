// Sun and weather for Burlington, VT.
import SunCalc from 'suncalc';

export const BTV = { lat: 44.4759, lon: -73.2121 };

// 0 = full day, 1 = full night; civil twilight (sun 0..-6 deg) blends between them.
export function nightFactor(date = new Date()) {
  const alt = SunCalc.getPosition(date, BTV.lat, BTV.lon).altitude * 180 / Math.PI;
  const t = Math.min(1, Math.max(0, (0.5 - alt) / 6.5));
  return t * t * (3 - 2 * t);
}

export function sunTimes(date = new Date()) {
  const t = SunCalc.getTimes(date, BTV.lat, BTV.lon);
  return { sunrise: t.sunrise, sunset: t.sunset, dusk: t.dusk, dawn: t.dawn };
}

// Map an NWS observation to one of the map's weather states.
export function classify(obs) {
  const text = (obs?.textDescription || '').toLowerCase();
  const pw = (obs?.presentWeather || []).map(p => `${p.weather || ''} ${p.rawString || ''}`.toLowerCase()).join(' ');
  const s = `${text} ${pw}`;
  const vis = obs?.visibility?.value; // metres
  let kind = 'clear';
  if (/thunder/.test(s)) kind = 'storm';
  else if (/snow|flurr|sleet|ice pellets|\bsn\b/.test(s)) kind = 'snow';
  else if (/rain|drizzle|shower|\bra\b|\bdz\b/.test(s)) kind = 'rain';
  else if (/fog|mist|haze|\bfg\b|\bbr\b/.test(s) || (vis != null && vis < 3000)) kind = 'fog';
  else if (/overcast|cloudy/.test(s)) kind = 'cloudy';
  else if (/partly|mostly sunny|few clouds|scattered/.test(s)) kind = 'partly';
  const heavy = /heavy|\+/.test(s);
  return {
    kind, heavy,
    text: obs?.textDescription || 'Unknown',
    tempF: obs?.temperature?.value == null ? null : Math.round(obs.temperature.value * 9 / 5 + 32),
    windMph: obs?.windSpeed?.value == null ? 0 : obs.windSpeed.value * 0.621371,
    windFromDeg: obs?.windDirection?.value ?? 270,
    time: obs?.timestamp ? new Date(obs.timestamp) : null,
  };
}

export async function fetchWeather(signal) {
  const r = await fetch('https://api.weather.gov/stations/KBTV/observations/latest', { headers: { Accept: 'application/geo+json' }, signal });
  if (!r.ok) throw new Error(`NWS ${r.status}`);
  const j = await r.json();
  return classify(j.properties);
}
