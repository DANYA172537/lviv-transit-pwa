(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const state = {
    from: { id: 'landmark:victoria-gardens', name: 'Вікторія Гарденс', lat: 49.80598, lon: 23.98002 },
    to: { id: 'landmark:santa-barbara', name: 'Санта Барбара', lat: 49.7855, lon: 24.0591 },
    activeField: 'from',
    suggestions: [],
    results: [],
    map: null,
    markerLayer: null,
    selectionLayer: null,
    selectedMarkers: { from: null, to: null },
    mapSelectionMode: 'from',
    mapUserMoved: false,
    mapHasAutoFitted: false,
    reverseRequest: 0,
    serviceWorkerRegistration: null,
    refreshingForUpdate: false,
    userLocation: null,
    liveTimer: null,
    toastTimer: null,
    installPrompt: null
  };

  const elements = {
    form: $('#planner-form'),
    fromInput: $('#from-input'),
    toInput: $('#to-input'),
    fromSelected: $('#from-selected'),
    toSelected: $('#to-selected'),
    suggestions: $('#suggestions'),
    timeMode: $('#time-mode'),
    timeField: $('#time-field'),
    timeInput: $('#time-input'),
    preference: $('#preference'),
    planButton: $('#plan-button'),
    status: $('#status-banner'),
    resultsSection: $('#results-section'),
    results: $('#results'),
    refreshPlan: $('#refresh-plan'),
    radius: $('#radius-select'),
    locate: $('#locate-button'),
    liveStatus: $('#live-status'),
    liveList: $('#live-list'),
    map: $('#map'),
    mapFallback: $('#map-fallback'),
    mapModeButtons: [...document.querySelectorAll('[data-map-mode]')],
    mapPickerHint: $('#map-picker-hint'),
    clearMapSelection: $('#clear-map-selection'),
    centerMap: $('#center-map'),
    mapPlan: $('#map-plan-button'),
    install: $('#install-button'),
    toast: $('#toast')
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function normalize(value) {
    return String(value || '').toLocaleLowerCase('uk-UA').trim();
  }

  function formatClockFromIso(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit' }).format(date);
  }

  function formatClockFromSeconds(value) {
    if (value == null) return '—';
    const seconds = ((Math.round(value) % 86400) + 86400) % 86400;
    return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`;
  }

  function formatDuration(seconds) {
    const minutes = Math.max(0, Math.round((seconds || 0) / 60));
    if (minutes < 60) return `${minutes} хв`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} год ${rest} хв` : `${hours} год`;
  }

  function formatDistance(meters) {
    if (meters == null) return '';
    if (meters < 1000) return `${Math.round(meters / 10) * 10} м`;
    return `${(meters / 1000).toFixed(1).replace('.', ',')} км`;
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add('is-visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 4200);
  }

  function setStatus(message, isError = false) {
    if (!message) {
      elements.status.hidden = true;
      return;
    }
    elements.status.hidden = false;
    elements.status.textContent = message;
    elements.status.classList.toggle('is-error', isError);
  }

  async function fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18_000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal, headers: { Accept: 'application/json', ...(options.headers || {}) } });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Помилка ${response.status}`);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  function placeValue(place) {
    if (!place) return '';
    return place.id ? place.id : place.name;
  }

  function updateSelectedLabels() {
    elements.fromSelected.textContent = state.from?.name || 'Оберіть місце';
    elements.toSelected.textContent = state.to?.name || 'Оберіть місце';
  }

  function inputDisplayValue(place) {
    if (!place) return '';
    return place.name || place.shortName || place.id || '';
  }

  function setInputDisplay(field, place) {
    const input = field === 'from' ? elements.fromInput : elements.toInput;
    input.value = inputDisplayValue(place);
    input.dataset.placeId = place?.id || '';
  }

  function setFieldValue(field, place) {
    const input = field === 'from' ? elements.fromInput : elements.toInput;
    const label = field === 'from' ? elements.fromSelected : elements.toSelected;
    if (!place) return;
    state[field] = place;
    setInputDisplay(field, place);
    label.textContent = place.name || place.shortName || 'Обране місце';
    renderSelectionMarkers();
    closeSuggestions();
  }

  async function searchPlaces(query) {
    if (!query.trim()) return [];
    try {
      const params = new URLSearchParams({ q: query });
      if (state.userLocation) {
        params.set('lat', state.userLocation.lat);
        params.set('lon', state.userLocation.lon);
      }
      const data = await fetchJson(`/api/places?${params}`);
      return data.places || [];
    } catch (error) {
      return [];
    }
  }

  function renderSuggestions() {
    const query = state.activeField === 'from' ? elements.fromInput.value : elements.toInput.value;
    if (!query.trim()) {
      closeSuggestions();
      return;
    }
    if (!state.suggestions.length) {
      closeSuggestions();
      return;
    }
    elements.suggestions.innerHTML = state.suggestions.slice(0, 8).map((place) => {
      const type = place.type === 'place' ? 'Місце' : 'Зупинка';
      const detail = place.desc || place.distance != null ? (place.desc || `${formatDistance(place.distance)} від вас`) : '';
      return `<button class="suggestion" type="button" data-place-id="${escapeHtml(place.id)}" role="option">
        <span><strong>${escapeHtml(place.name)}</strong><small>${escapeHtml(detail)}</small></span>
        <span class="suggestion-type">${type}</span>
      </button>`;
    }).join('');
    elements.suggestions.classList.add('is-open');
  }

  function closeSuggestions() {
    state.suggestions = [];
    elements.suggestions.classList.remove('is-open');
    elements.suggestions.innerHTML = '';
  }

  async function handleFieldInput(field) {
    state.activeField = field;
    const input = field === 'from' ? elements.fromInput : elements.toInput;
    const value = input.value;
    input.dataset.placeId = '';
    if (!value.trim()) {
      closeSuggestions();
      return;
    }
    state.suggestions = await searchPlaces(value);
    renderSuggestions();
  }

  function chooseSuggestion(id) {
    const place = state.suggestions.find((item) => item.id === id);
    if (place) setFieldValue(state.activeField, place);
  }

  function routeLabel(route) {
    return route || '—';
  }

  function renderRouteCard(option, index) {
    const isBest = index === 0;
    const transferText = option.transfers === 0 ? 'без пересадок' : `${option.transfers} ${option.transfers === 1 ? 'пересадка' : 'пересадки'}`;
    const firstBoard = option.legs?.[0]?.boardAt;
    const firstBoardDay = option.legs?.[0]?.dayOffset ? 'завтра ' : '';
    const legs = option.legs.map((leg, legIndex) => {
      const previous = option.legs[legIndex - 1];
      const wait = previous ? Math.max(0, Math.round((leg.boardAt - previous.alightAt) / 60)) : null;
      return `${wait != null ? `<p class="transfer-note">Пересадка · ${wait} хв на зупинці</p>` : ''}
        <div class="leg">
          <span class="route-badge">${escapeHtml(routeLabel(leg.route))}</span>
          <div class="leg-main">
            <div class="leg-line"><strong>${escapeHtml(leg.headsign || leg.routeLongName || 'Маршрут')}</strong><time>${formatClockFromSeconds(leg.boardAt)}–${formatClockFromSeconds(leg.alightAt)}</time></div>
            <div class="leg-stops"><span>${escapeHtml(leg.boardStopName)}</span><span>${escapeHtml(leg.alightStopName)}</span></div>
          </div>
        </div>`;
    }).join('');
    return `<article class="route-card ${isBest ? 'is-best' : ''}">
      <div class="route-card-head">
        <div class="route-time">${formatClockFromSeconds(option.arrivalAt)} <small>прибуття${option.arrivalDayOffset ? ' завтра' : ''}</small></div>
        ${isBest ? '<span class="recommend-badge">✦ найкращий</span>' : ''}
      </div>
      <p class="route-summary">З місця о ${formatClockFromSeconds(option.departureAt)} · перший транспорт ${firstBoardDay}о ${formatClockFromSeconds(firstBoard)} · ${transferText}</p>
      <div class="route-metrics">
        <span class="metric">🚶 ${option.walkFromMinutes + option.walkToMinutes} хв пішки</span>
        <span class="metric">⏱ ${formatDuration(option.duration)}</span>
        ${option.waitMinutes ? `<span class="metric">⌛ очікування ${option.waitMinutes} хв</span>` : ''}
      </div>
      <div class="legs">${legs}</div>
    </article>`;
  }

  function plural(number, one, few, many) {
    const mod10 = number % 10;
    const mod100 = number % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function recommendationText(options) {
    if (!options?.length) return 'На обраний час маршрутів не знайшлося.';
    const best = options[0];
    const routeText = best.routeNames.join(' + ');
    const firstBoard = best.legs?.[0]?.boardAt;
    const firstBoardDay = best.legs?.[0]?.dayOffset ? 'завтра ' : '';
    const arrivalDay = best.arrivalDayOffset ? 'завтра ' : '';
    let text = best.waitMinutes >= 60
      ? `Зараз повного маршруту немає. Найближчий варіант: ${routeText}, перший транспорт ${firstBoardDay}о ${formatClockFromSeconds(firstBoard)}, прибуття ${arrivalDay}о ${formatClockFromSeconds(best.arrivalAt)}.`
      : `Зараз вигідніше: ${routeText}, прибуття о ${formatClockFromSeconds(best.arrivalAt)}.`;
    const later = options.find((option) => option.arrivalAt >= best.arrivalAt + 5 * 60);
    if (later) {
      const difference = Math.max(1, Math.round((later.arrivalAt - best.arrivalAt) / 60));
      text += ` Варіант ${later.routeNames.join(' + ')} приїде приблизно на ${difference} ${plural(difference, 'хвилину', 'хвилини', 'хвилин')} пізніше.`;
    } else if (best.waitMinutes >= 10) {
      text += ` Але доведеться почекати ${best.waitMinutes} ${plural(best.waitMinutes, 'хвилину', 'хвилини', 'хвилин')}.`;
    }
    if (best.source?.includes('live')) text += ' Враховано поточну затримку з GPS-даних.';
    return text;
  }

  function renderResults(payload) {
    state.results = payload.options || [];
    elements.resultsSection.hidden = false;
    if (!state.results.length) {
      elements.results.innerHTML = '<div class="empty-state">На обраний час маршрутів не знайшлося. Спробуй пізніше або обери іншу зупинку.</div>';
      return;
    }
    elements.results.innerHTML = state.results.map(renderRouteCard).join('');
    if (!state.mapUserMoved) fitMapToSelection();
  }

  function queryString() {
    const params = new URLSearchParams({
      from: placeValue(state.from),
      to: placeValue(state.to),
      preference: elements.preference.value
    });
    if (elements.timeMode.value === 'time' && elements.timeInput.value) params.set('at', elements.timeInput.value);
    if (state.from?.lat != null && state.from?.lon != null) {
      params.set('fromLat', state.from.lat);
      params.set('fromLon', state.from.lon);
    }
    if (state.to?.lat != null && state.to?.lon != null) {
      params.set('toLat', state.to.lat);
      params.set('toLon', state.to.lon);
    }
    return params;
  }

  async function planRoute() {
    elements.planButton.disabled = true;
    elements.planButton.innerHTML = 'Шукаю…';
    setStatus('Рахую маршрути за розкладом…');
    try {
      const payload = await fetchJson(`/api/plan?${queryString()}`);
      if (payload.from) state.from = { ...payload.from, ...state.from, lat: payload.from.lat, lon: payload.from.lon, stopIds: payload.from.stopIds };
      if (payload.to) state.to = { ...payload.to, ...state.to, lat: payload.to.lat, lon: payload.to.lon, stopIds: payload.to.stopIds };
      setInputDisplay('from', state.from);
      setInputDisplay('to', state.to);
      updateSelectedLabels();
      renderSelectionMarkers();
      renderResults(payload);
      const when = elements.timeMode.value === 'time' ? ` на ${elements.timeInput.value}` : '';
      setStatus(`${recommendationText(payload.options)}${when ? ` (розрахунок на ${elements.timeInput.value})` : ''}`);
      await loadLive();
    } catch (error) {
      elements.resultsSection.hidden = false;
      elements.results.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
      setStatus(error.message, true);
    } finally {
      elements.planButton.disabled = false;
      elements.planButton.innerHTML = 'Знайти маршрут <span>→</span>';
    }
  }

  function updateMapModeButtons() {
    const modeLabel = state.mapSelectionMode === 'from' ? 'Звідки' : 'Куди';
    elements.mapModeButtons.forEach((button) => {
      const active = button.dataset.mapMode === state.mapSelectionMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    if (elements.mapPickerHint) {
      elements.mapPickerHint.textContent = `Клацни точку: ${modeLabel}. Потім натисни «Маршрут →» нижче.`;
    }
  }

  function setMapMode(field) {
    if (field !== 'from' && field !== 'to') return;
    state.mapSelectionMode = field;
    updateMapModeButtons();
  }

  function coordinateId(lat, lon) {
    return `coord:${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;
  }

  function setMapCoordinate(field, lat, lon, name = 'Обрана точка на карті') {
    const place = {
      id: coordinateId(lat, lon),
      name,
      type: 'coordinate',
      lat: Number(lat),
      lon: Number(lon)
    };
    setFieldValue(field, place);
    state.mapUserMoved = true;
    updateMapModeButtons();
    return place;
  }

  async function handleMapClick(event) {
    const field = state.mapSelectionMode;
    const lat = Number(event.latlng.lat);
    const lon = Number(event.latlng.lng);
    const place = setMapCoordinate(field, lat, lon);
    const requestId = ++state.reverseRequest;
    if (elements.mapPickerHint) elements.mapPickerHint.textContent = 'Визначаю назву точки…';
    try {
      const data = await fetchJson(`/api/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
      if (requestId !== state.reverseRequest || state[field]?.id !== place.id) return;
      const name = data.name || data.displayName?.split(',')[0] || 'Обрана точка на карті';
      state[field] = { ...state[field], name };
      setInputDisplay(field, state[field]);
      updateSelectedLabels();
      renderSelectionMarkers();
      if (elements.mapPickerHint) elements.mapPickerHint.textContent = `${field === 'from' ? 'Звідки' : 'Куди'} обрано. Можеш клацнути ще одну точку.`;
    } catch {
      if (requestId === state.reverseRequest && elements.mapPickerHint) {
        elements.mapPickerHint.textContent = 'Точку обрано, але назву вулиці не вдалося визначити.';
      }
    }
  }

  function clearMapPoint() {
    const field = state.mapSelectionMode;
    const input = field === 'from' ? elements.fromInput : elements.toInput;
    const label = field === 'from' ? elements.fromSelected : elements.toSelected;
    state[field] = null;
    input.value = '';
    input.dataset.placeId = '';
    label.textContent = 'Оберіть точку на карті';
    renderSelectionMarkers();
    updateMapModeButtons();
    showToast(field === 'from' ? 'Точку початку очищено.' : 'Точку призначення очищено.');
  }

  function renderSelectionMarkers() {
    if (!state.map || !state.selectionLayer) return;
    state.selectionLayer.clearLayers();
    ['from', 'to'].forEach((field) => {
      const place = state[field];
      if (!place || !Number.isFinite(Number(place.lat)) || !Number.isFinite(Number(place.lon))) return;
      const isFrom = field === 'from';
      const marker = L.marker([Number(place.lat), Number(place.lon)], {
        zIndexOffset: isFrom ? 700 : 800,
        icon: L.divIcon({
          className: '',
          html: `<div class="selection-marker ${field}">${isFrom ? 'З' : 'К'}</div>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15]
        })
      });
      marker.bindTooltip(`${isFrom ? 'Звідки' : 'Куди'}: ${escapeHtml(place.name || 'точка на карті')}`, { direction: 'top', offset: [0, -13] });
      marker.on('click', (event) => {
        if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
      });
      marker.addTo(state.selectionLayer);
      state.selectedMarkers[field] = marker;
    });
  }

  function fitMapToSelection() {
    if (!state.map) return;
    const points = [state.from, state.to]
      .filter((place) => place && Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lon)))
      .map((place) => [Number(place.lat), Number(place.lon)]);
    if (points.length >= 2) {
      state.map.fitBounds(points, { padding: [35, 35], maxZoom: 15 });
    } else if (points.length === 1) {
      state.map.setView(points[0], 14);
    } else {
      state.map.setView([49.8397, 24.0297], 12);
    }
    state.mapUserMoved = false;
    state.mapHasAutoFitted = true;
  }

  function initMap() {
    if (!window.L) {
      elements.mapFallback.hidden = false;
      return;
    }
    try {
      state.map = L.map('map', {
        zoomControl: true,
        attributionControl: true,
        maxBounds: [[49.60, 23.65], [50.15, 24.55]],
        maxBoundsViscosity: 0.8
      }).setView([49.8397, 24.0297], 12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap'
      }).addTo(state.map);
      state.markerLayer = L.layerGroup().addTo(state.map);
      state.selectionLayer = L.layerGroup().addTo(state.map);
      state.map.on('click', handleMapClick);
      state.map.on('dragstart', () => { state.mapUserMoved = true; });
      updateMapModeButtons();
      renderSelectionMarkers();
      setTimeout(() => state.map.invalidateSize(), 0);
    } catch {
      elements.mapFallback.hidden = false;
    }
  }

  function clearMarkers() {
    if (state.markerLayer) state.markerLayer.clearLayers();
  }

  function renderMap(vehicles) {
    if (!state.map || !state.markerLayer) return;
    clearMarkers();
    const bounds = [];
    vehicles.forEach((vehicle) => {
      const marker = L.marker([vehicle.lat, vehicle.lon], {
        icon: L.divIcon({ className: '', html: `<div class="vehicle-marker">${escapeHtml(vehicle.route)}</div>`, iconSize: [25, 25], iconAnchor: [12, 12] })
      });
      const direction = vehicle.delaySeconds == null ? '' : vehicle.delaySeconds > 45 ? ` · затримка ${Math.round(vehicle.delaySeconds / 60)} хв` : vehicle.delaySeconds < -45 ? ` · раніше на ${Math.round(Math.abs(vehicle.delaySeconds) / 60)} хв` : '';
      marker.bindPopup(`<strong>Маршрут ${escapeHtml(vehicle.route)}</strong><br>${escapeHtml(vehicle.headsign || '')}<br>${vehicle.speed ? `${Math.round(vehicle.speed)} км/год` : 'стоїть'}${direction}`);
      marker.addTo(state.markerLayer);
      bounds.push([vehicle.lat, vehicle.lon]);
    });
    if (bounds.length && !state.mapHasAutoFitted && !state.mapUserMoved) {
      state.map.fitBounds(bounds, { padding: [24, 24], maxZoom: 15 });
      state.mapHasAutoFitted = true;
    }
  }

  function renderLive(vehicles) {
    if (!vehicles.length) {
      elements.liveList.innerHTML = '<div class="empty-state">У вибраному радіусі зараз немає активних транспортів або вони не передають своє місце.</div>';
      return;
    }
    elements.liveList.innerHTML = vehicles.slice(0, 30).map((vehicle) => {
      const delay = vehicle.delaySeconds;
      const delayText = delay == null ? '' : delay > 45 ? `<span class="delay-late">+${Math.round(delay / 60)} хв</span>` : delay < -45 ? `<span class="delay-early">-${Math.round(Math.abs(delay) / 60)} хв</span>` : 'вчасно';
      return `<button class="live-row" type="button" data-lat="${vehicle.lat}" data-lon="${vehicle.lon}">
        <span class="live-route">${escapeHtml(vehicle.route)}</span>
        <span><span class="live-destination">${escapeHtml(vehicle.headsign || 'Невідомий напрямок')}</span><span class="live-meta">${vehicle.distance != null ? `${formatDistance(vehicle.distance)} від центру` : 'остання позиція'}${vehicle.speed ? ` · ${Math.round(vehicle.speed)} км/год` : ' · зупинка'}</span></span>
        <span class="live-time">${formatClockFromIso(vehicle.updatedAt)}<br><small>${delayText || '—'}</small></span>
      </button>`;
    }).join('');
  }

  async function loadLive() {
    const center = state.userLocation || (state.from?.lat != null ? state.from : { lat: 49.8397, lon: 24.0297 });
    const params = new URLSearchParams({ lat: center.lat, lon: center.lon, radius: elements.radius.value });
    const routeNames = [...new Set(state.results.flatMap((option) => option.routeNames || []))].slice(0, 12);
    if (routeNames.length) params.set('route', routeNames.join(','));
    try {
      const data = await fetchJson(`/api/live?${params}`);
      renderLive(data.vehicles || []);
      renderMap(data.vehicles || []);
      const count = data.vehicles?.length || 0;
      elements.liveStatus.textContent = count ? `${count} у радіусі` : 'Дані недоступні';
      if (data.errors?.positions) elements.liveStatus.textContent = 'часткова відповідь';
    } catch (error) {
      elements.liveStatus.textContent = 'недоступно';
      elements.liveList.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
  }

  function locateUser() {
    if (!navigator.geolocation) {
      showToast('Геолокація не підтримується цим браузером.');
      return;
    }
    elements.locate.textContent = '📍 Визначаю…';
    navigator.geolocation.getCurrentPosition((position) => {
      state.userLocation = { lat: position.coords.latitude, lon: position.coords.longitude };
      elements.locate.textContent = '📍 Моє місце';
      if (state.map) state.map.setView([state.userLocation.lat, state.userLocation.lon], 13);
      showToast('Показано транспорт поруч з тобою.');
      loadLive();
    }, () => {
      elements.locate.textContent = '📍 Моє місце';
      showToast('Не вдалося визначити місце. Дозволи доступ до геолокації в Safari.');
    }, { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 });
  }

  function installApp() {
    if (state.installPrompt) {
      state.installPrompt.prompt();
      state.installPrompt.userChoice.finally(() => { state.installPrompt = null; });
      return;
    }
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    showToast(isIos ? 'У Safari натисни «Поділитися» → «На екран Home».' : 'Відкрий меню браузера та вибери «Встановити застосунок».');
  }

  function bindEvents() {
    elements.form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!elements.fromInput.value.trim() || !elements.toInput.value.trim()) return;
      const fromValue = elements.fromInput.value.trim();
      const toValue = elements.toInput.value.trim();
      const fromId = elements.fromInput.dataset.placeId || fromValue;
      const toId = elements.toInput.dataset.placeId || toValue;
      if (state.from?.id !== fromId) state.from = { id: fromId, name: fromValue };
      if (state.to?.id !== toId) state.to = { id: toId, name: toValue };
      updateSelectedLabels();
      closeSuggestions();
      planRoute();
    });

    let searchTimer;
    [elements.fromInput, elements.toInput].forEach((input, index) => {
      input.addEventListener('focus', () => { state.activeField = index === 0 ? 'from' : 'to'; });
      input.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => handleFieldInput(state.activeField), 220);
      });
    });

    elements.suggestions.addEventListener('click', (event) => {
      const button = event.target.closest('[data-place-id]');
      if (button) chooseSuggestion(button.dataset.placeId);
    });
    document.addEventListener('click', (event) => {
      if (!elements.suggestions.contains(event.target) && event.target !== elements.fromInput && event.target !== elements.toInput) closeSuggestions();
    });
    $('#swap-button').addEventListener('click', () => {
      const from = state.from;
      state.from = state.to;
      state.to = from;
      setInputDisplay('from', state.from);
      setInputDisplay('to', state.to);
      updateSelectedLabels();
      renderSelectionMarkers();
    });
    document.querySelectorAll('[data-place]').forEach((button) => button.addEventListener('click', () => {
      const field = button.dataset.field;
      const place = {
        id: button.dataset.place,
        name: button.textContent.trim(),
        lat: field === 'from' ? 49.80598 : undefined,
        lon: field === 'from' ? 23.98002 : undefined
      };
      setFieldValue(field, place);
    }));
    elements.timeMode.addEventListener('change', () => elements.timeField.classList.toggle('is-hidden', elements.timeMode.value !== 'time'));
    elements.refreshPlan.addEventListener('click', planRoute);
    elements.radius.addEventListener('change', loadLive);
    elements.locate.addEventListener('click', locateUser);
    elements.mapModeButtons.forEach((button) => button.addEventListener('click', () => setMapMode(button.dataset.mapMode)));
    elements.clearMapSelection.addEventListener('click', clearMapPoint);
    elements.centerMap.addEventListener('click', fitMapToSelection);
    elements.mapPlan.addEventListener('click', () => {
      planRoute().then(() => elements.resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    });
    elements.install.addEventListener('click', installApp);
    elements.liveList.addEventListener('click', (event) => {
      const row = event.target.closest('[data-lat]');
      if (!row || !state.map) return;
      state.map.setView([Number(row.dataset.lat), Number(row.dataset.lon)], 15);
    });
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      state.installPrompt = event;
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const hadController = Boolean(navigator.serviceWorker.controller);
    const watchWorker = (worker) => {
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          showToast('Оновлення завантажено. Оновлюю застосунок…');
          worker.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    };
    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
        state.serviceWorkerRegistration = registration;
        watchWorker(registration.waiting);
        watchWorker(registration.installing);
        registration.addEventListener('updatefound', () => watchWorker(registration.installing));
        await registration.update().catch(() => {});
      } catch {
        // The app remains usable without a service worker.
      }
    };

    register();
    const checkForUpdate = () => {
      if (navigator.onLine) state.serviceWorkerRegistration?.update().catch(() => {});
    };
    window.addEventListener('online', () => {
      showToast('Мережа з’явилася. Перевіряю оновлення…');
      checkForUpdate();
    });
    window.addEventListener('focus', checkForUpdate);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) checkForUpdate();
    });
    window.setInterval(() => {
      if (!document.hidden) checkForUpdate();
    }, 15 * 60 * 1000);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || state.refreshingForUpdate) return;
      state.refreshingForUpdate = true;
      window.location.reload();
    });
  }

  async function init() {
    bindEvents();
    setInputDisplay('from', state.from);
    setInputDisplay('to', state.to);
    updateSelectedLabels();
    updateMapModeButtons();
    initMap();
    await planRoute();
    state.liveTimer = setInterval(() => {
      if (!document.hidden) loadLive();
    }, 20_000);
  }

  window.addEventListener('DOMContentLoaded', () => {
    init();
    registerServiceWorker();
  });
})();
