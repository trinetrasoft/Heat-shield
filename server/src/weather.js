export function simulatedWeather() {
  const peakC = 35.5;
  const troughC = 27;
  const sample = (lat, lng, at) => {
    const hour = (at.getUTCHours() + at.getUTCMinutes() / 60 + lng / 15 + 24) % 24;
    const wave = Math.cos(((hour - 14.5) / 24) * 2 * Math.PI);
    const latitudeFactor = Math.max(0.6, 1 - Math.abs(lat - 24) / 60);
    const temp = troughC + ((peakC - troughC) * (wave + 1)) / 2;
    const airTempC = Math.round((temp * latitudeFactor + (1 - latitudeFactor) * 22) * 10) / 10;
    return {
      observedAt: at,
      airTempC,
      relativeHumidity: Math.round(Math.min(90, Math.max(18, 78 - (airTempC - troughC) * 3.2))),
      windMs: 2.5,
    };
  };
  return {
    label: "Simulated weather (demo only)",
    async fetch(latitude, longitude, now) {
      const start = new Date(now);
      start.setUTCMinutes(0, 0, 0);
      const hourly = Array.from({ length: 24 }, (_, index) =>
        sample(latitude, longitude, new Date(start.getTime() + index * 3_600_000)),
      );
      return { current: sample(latitude, longitude, new Date(now.getTime() - 600_000)), hourly };
    },
  };
}

export function openMeteoWeather() {
  return {
    label: "Open-Meteo",
    async fetch(latitude, longitude, now) {
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.searchParams.set("latitude", String(latitude));
      url.searchParams.set("longitude", String(longitude));
      url.searchParams.set("current", "temperature_2m,relative_humidity_2m,wind_speed_10m");
      url.searchParams.set("hourly", "temperature_2m,relative_humidity_2m,wind_speed_10m");
      url.searchParams.set("forecast_days", "2");
      url.searchParams.set("wind_speed_unit", "ms");
      url.searchParams.set("timezone", "UTC");
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`Weather provider returned ${response.status}`);
      const body = await response.json();
      const current = body.current;
      const times = body.hourly?.time ?? [];
      const hourly = times.map((time, index) => ({
        observedAt: new Date(time.endsWith("Z") ? time : `${time}Z`),
        airTempC: body.hourly.temperature_2m[index],
        relativeHumidity: body.hourly.relative_humidity_2m[index],
        windMs: body.hourly.wind_speed_10m[index],
      }));
      return {
        current: current
          ? {
              observedAt: new Date(current.time.endsWith("Z") ? current.time : `${current.time}Z`),
              airTempC: current.temperature_2m,
              relativeHumidity: current.relative_humidity_2m,
              windMs: current.wind_speed_10m,
            }
          : null,
        hourly,
      };
    },
  };
}

export function createWeather(provider) {
  if (provider === "simulated") return simulatedWeather();
  return openMeteoWeather();
}
