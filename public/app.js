// State management
let currentRole = 'reader';
let currentToken = '';
let equipos = [];
let activeLocks = {}; // Format: { "id-field": "client_X" }
let ws = null;
let wsReconnectTimer = null;
let debounceTimers = {}; // Format: { "id-field": timer }
let currentViewMode = 'grid'; // 'grid' or 'list'
let currentShowAnalytics = false; // Toggle analytics state
let charts = {}; // Chart.js instances: { progress, sede, zona }

// DOM Elements
const loginScreen = document.getElementById('login-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const loginPasswordInput = document.getElementById('login-password');
const loginForm = document.getElementById('login-editor-form');
const loginError = document.getElementById('login-error');
const btnLoginReader = document.getElementById('btn-login-reader');
const btnLogout = document.getElementById('btn-logout');
const roleBadge = document.getElementById('role-badge');
const roleText = document.getElementById('role-text');
const connBanner = document.getElementById('conn-banner');

// View & Action Elements
const btnViewGrid = document.getElementById('btn-view-grid');
const btnViewList = document.getElementById('btn-view-list');
const btnToggleAnalytics = document.getElementById('btn-toggle-analytics');
const btnDownloadPdf = document.getElementById('btn-download-pdf');
const analyticsPanel = document.getElementById('analytics-panel');

// Stats Elements
const statsTotal = document.getElementById('stats-total');
const statsPending = document.getElementById('stats-pending');
const statsCompleted = document.getElementById('stats-completed');

// Filter Elements
const filterSearch = document.getElementById('filter-search');
const filterSede = document.getElementById('filter-sede');
const filterZona = document.getElementById('filter-zona');
const filterHasCorrective = document.getElementById('filter-has-corrective');
const filterOnlyPending = document.getElementById('filter-only-pending');
const equipmentGrid = document.getElementById('equipment-grid');

// Initialize app
function init() {
  const savedRole = localStorage.getItem('cocesna_role');
  const savedToken = localStorage.getItem('cocesna_token');
  
  if (savedRole) {
    currentRole = savedRole;
    currentToken = savedToken || '';
    showDashboard();
  } else {
    showLogin();
  }
  
  // Load saved view mode
  const savedView = localStorage.getItem('cocesna_view_mode') || 'grid';
  setViewMode(savedView);
  
  // Set up event listeners
  btnLoginReader.addEventListener('click', loginAsReader);
  loginForm.addEventListener('submit', loginAsEditor);
  btnLogout.addEventListener('click', logout);
  
  if (btnViewGrid && btnViewList) {
    btnViewGrid.addEventListener('click', () => setViewMode('grid'));
    btnViewList.addEventListener('click', () => setViewMode('list'));
  }
  
  if (btnToggleAnalytics) {
    btnToggleAnalytics.addEventListener('click', toggleAnalytics);
  }
  
  if (btnDownloadPdf) {
    btnDownloadPdf.addEventListener('click', exportToPDF);
  }
  
  filterSearch.addEventListener('input', () => renderEquipos());
  filterSede.addEventListener('change', () => renderEquipos());
  filterZona.addEventListener('change', () => renderEquipos());
  filterHasCorrective.addEventListener('change', () => renderEquipos());
  filterOnlyPending.addEventListener('change', () => renderEquipos());
}

// Authentication Functions
function showLogin() {
  loginScreen.classList.remove('hidden');
  dashboardScreen.classList.add('hidden');
  stopWebSocket();
}

function showDashboard() {
  loginScreen.classList.add('hidden');
  dashboardScreen.classList.remove('hidden');
  
  if (currentRole === 'editor') {
    roleBadge.className = 'badge editor';
    roleText.textContent = 'Editor';
  } else {
    roleBadge.className = 'badge reader';
    roleText.textContent = 'Lector';
  }
  
  loadData();
  startWebSocket();
}

function loginAsReader() {
  currentRole = 'reader';
  currentToken = '';
  localStorage.setItem('cocesna_role', 'reader');
  localStorage.removeItem('cocesna_token');
  showDashboard();
}

async function loginAsEditor(e) {
  e.preventDefault();
  const password = loginPasswordInput.value;
  
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ password })
    });
    
    if (response.ok) {
      const data = await response.json();
      currentRole = 'editor';
      currentToken = data.token;
      localStorage.setItem('cocesna_role', 'editor');
      localStorage.setItem('cocesna_token', data.token);
      loginPasswordInput.value = '';
      loginError.classList.add('hidden');
      showDashboard();
    } else {
      loginError.classList.remove('hidden');
    }
  } catch (error) {
    console.error('Error during login:', error);
    loginError.textContent = 'Error de conexión con el servidor.';
    loginError.classList.remove('hidden');
  }
}

function logout() {
  localStorage.removeItem('cocesna_role');
  localStorage.removeItem('cocesna_token');
  currentRole = 'reader';
  currentToken = '';
  showLogin();
}

// Data Fetching
async function loadData() {
  equipmentGrid.innerHTML = `
    <div class="loading-spinner">
      <span class="material-symbols-outlined spin">progress_activity</span>
      Cargando inventario de equipos...
    </div>
  `;
  
  try {
    const headers = {};
    if (currentToken) {
      headers['Authorization'] = currentToken;
    }
    
    const response = await fetch('/api/equipos', { headers });
    if (!response.ok) {
      if (response.status === 401) {
        logout();
        return;
      }
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to fetch data');
    }
    
    equipos = await response.json();
    populateSedeDropdown();
    calculateStats();
    renderEquipos();
  } catch (error) {
    console.error('Error fetching data:', error);
    equipmentGrid.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined empty-state-icon text-warning">error</span>
        <h3>Error al cargar datos</h3>
        <p>${error.message}</p>
        <button onclick="loadData()" class="btn btn-primary" style="margin-top: 16px;">Reintentar</button>
      </div>
    `;
  }
}

// Dropdown population
function populateSedeDropdown() {
  const sedes = [...new Set(equipos.map(item => item.sede))].filter(Boolean).sort();
  const currentSelection = filterSede.value;
  
  filterSede.innerHTML = '<option value="">Todas las sedes</option>';
  sedes.forEach(sede => {
    const option = document.createElement('option');
    option.value = sede;
    option.textContent = sede;
    filterSede.appendChild(option);
  });
  
  if (sedes.includes(currentSelection)) {
    filterSede.value = currentSelection;
  }
}

// Stats Calculation (Iterates over 1:N correctives structure)
function calculateStats() {
  const total = equipos.length;
  let pending = 0;
  let completed = 0;
  
  equipos.forEach(eq => {
    const list = eq.correctivos || [];
    list.forEach(c => {
      if (!c.correctivo_sugerido) return; // Skip empty fields
      if (c.realizado === 1) completed++;
      else pending++;
    });
  });
  
  statsTotal.textContent = total;
  statsPending.textContent = pending;
  statsCompleted.textContent = completed;
}

// Get filtered list (shared helper)
function getFilteredEquipos() {
  const searchVal = filterSearch.value.toLowerCase().trim();
  const sedeVal = filterSede.value;
  const zonaVal = filterZona.value;
  const hasCorrectiveVal = filterHasCorrective.checked;
  const onlyPendingVal = filterOnlyPending.checked;
  
  return equipos.filter(item => {
    if (sedeVal && item.sede !== sedeVal) return false;
    if (zonaVal && item.zona !== zonaVal) return false;
    
    // Search text (indexes equipo, edificio, capacity, id num, correctives text)
    if (searchVal) {
      const equipo = (item.equipo || '').toLowerCase();
      const edificio = (item.edificio || '').toLowerCase();
      const cap = (item.capacidad || '').toLowerCase();
      const num = String(item.numero_equipo || '');
      
      const correctivesText = (item.correctivos || [])
        .map(c => (c.correctivo_sugerido || '').toLowerCase() + ' ' + (c.items_a_cotizar || '').toLowerCase())
        .join(' ');
        
      const match = equipo.includes(searchVal) || edificio.includes(searchVal) || cap.includes(searchVal) || num.includes(searchVal) || correctivesText.includes(searchVal);
      if (!match) return false;
    }
    
    // Filters correctives state
    const activeCorrectives = (item.correctivos || []).filter(c => c.correctivo_sugerido);
    
    if (hasCorrectiveVal && activeCorrectives.length === 0) return false;
    
    if (onlyPendingVal) {
      const pendingCorrectives = activeCorrectives.filter(c => c.realizado === 0);
      if (pendingCorrectives.length === 0) return false;
    }
    
    return true;
  });
}

// Render the grid
function renderEquipos() {
  const filtered = getFilteredEquipos();
  
  if (filtered.length === 0) {
    equipmentGrid.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined empty-state-icon">search_off</span>
        <h3>No se encontraron equipos</h3>
        <p>Intente cambiando los filtros o el texto de búsqueda.</p>
      </div>
    `;
    renderCharts();
    return;
  }
  
  equipmentGrid.innerHTML = '';
  filtered.forEach(item => {
    const card = createEquipmentCard(item);
    equipmentGrid.appendChild(card);
  });
  
  renderCharts();
}

// Card DOM Creation
function createEquipmentCard(item) {
  const isEditor = currentRole === 'editor';
  const card = document.createElement('div');
  card.className = 'equip-card card';
  card.dataset.id = item.id;
  
  // Header section
  const header = document.createElement('div');
  header.className = 'equip-card-header';
  
  // Toggle expansion in list view
  header.addEventListener('click', (e) => {
    if (currentViewMode === 'list' && !e.target.closest('.checkbox-realizado-container') && !e.target.closest('.badge-realizado') && !e.target.closest('.btn-edit-toggle') && !e.target.closest('.btn-add-corrective') && !e.target.closest('.btn-delete-corrective')) {
      card.classList.toggle('expanded');
    }
  });
  
  const titleBadges = document.createElement('div');
  titleBadges.className = 'equip-card-badges';
  
  // Badge Row (Sede, Zona, Número de equipo, Reincidencia)
  const badgeRow = document.createElement('div');
  badgeRow.className = 'badge-row';
  
  const sedeBadge = document.createElement('span');
  sedeBadge.className = 'badge-sede';
  sedeBadge.textContent = item.sede;
  badgeRow.appendChild(sedeBadge);
  
  if (item.zona) {
    const zonaBadge = document.createElement('span');
    zonaBadge.className = item.zona === 'GAM' ? 'badge-zona-gam' : 'badge-zona-foraneo';
    zonaBadge.textContent = item.zona;
    badgeRow.appendChild(zonaBadge);
  }
  
  if (item.numero_equipo !== null && item.numero_equipo !== undefined) {
    const numBadge = document.createElement('span');
    numBadge.className = 'badge-numero';
    numBadge.textContent = `#${item.numero_equipo}`;
    badgeRow.appendChild(numBadge);
  }
  
  // Reincidencia Badge (checks for multiple registered correctives)
  const correctivesCount = (item.correctivos || []).filter(c => c.correctivo_sugerido).length;
  if (correctivesCount === 2) {
    const rBadge = document.createElement('span');
    rBadge.className = 'badge-reincidencia-media';
    rBadge.innerHTML = '<span class="material-symbols-outlined" style="font-size:12px;">info</span> Reincidencia: 2';
    badgeRow.appendChild(rBadge);
  } else if (correctivesCount >= 3) {
    const rBadge = document.createElement('span');
    rBadge.className = 'badge-reincidencia-alta';
    rBadge.innerHTML = `<span class="material-symbols-outlined" style="font-size:12px;">warning</span> Reincidencia: ${correctivesCount}`;
    badgeRow.appendChild(rBadge);
  }
  
  titleBadges.appendChild(badgeRow);
  
  // Title (Área / Nombre de equipo)
  const areaTitle = document.createElement('h3');
  areaTitle.className = 'equip-area';
  areaTitle.textContent = item.equipo;
  titleBadges.appendChild(areaTitle);
  
  // Subtitle (Sitio / Edificio)
  const edificioSubtitle = document.createElement('div');
  edificioSubtitle.className = 'equip-edificio';
  edificioSubtitle.innerHTML = `<span class="material-symbols-outlined">business</span> ${item.edificio}`;
  titleBadges.appendChild(edificioSubtitle);
  
  header.appendChild(titleBadges);
  card.appendChild(header);
  
  // Card Body
  const body = document.createElement('div');
  body.className = 'card-body';
  
  // 1. Capacidad del Equipo (Equipment property)
  const fieldCapacidad = createFieldGroupInline(
    'capacidad', 
    'Capacidad del Equipo', 
    'ac_unit', 
    item.capacidad, 
    'Ej: 18.000 BTU, 36.000 BTU...', 
    item.id,
    isEditor,
    true // isEquipmentField
  );
  body.appendChild(fieldCapacidad);
  
  // 2. Historial de Correctivos (1:N Sub-cards)
  const historyTitle = document.createElement('h4');
  historyTitle.className = 'field-label';
  historyTitle.style.marginTop = '16px';
  historyTitle.style.marginBottom = '8px';
  historyTitle.innerHTML = '<span class="material-symbols-outlined">history</span> Historial de Correctivos';
  body.appendChild(historyTitle);
  
  const historyContainer = document.createElement('div');
  historyContainer.className = 'corrective-history-container';
  
  const validCorrectives = (item.correctivos || []);
  
  if (validCorrectives.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'field-value-readonly empty';
    emptyMsg.textContent = 'Sin correctivos registrados';
    historyContainer.appendChild(emptyMsg);
  } else {
    validCorrectives.forEach((corr, index) => {
      const corrCard = createCorrectiveSubcard(corr, index + 1, item.id, isEditor);
      historyContainer.appendChild(corrCard);
    });
  }
  
  // Add corrective button for Editors
  if (isEditor) {
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-add-corrective';
    addBtn.innerHTML = '<span class="material-symbols-outlined">add_circle</span> Agregar Correctivo';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      addCorrective(item.id);
    });
    historyContainer.appendChild(addBtn);
  }
  body.appendChild(historyContainer);
  
  // Card Edit button for Editors
  if (isEditor) {
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'card-actions';
    
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-secondary btn-edit-toggle';
    editBtn.innerHTML = '<span class="material-symbols-outlined">edit</span> <span>Editar</span>';
    
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isEditing = card.classList.toggle('editing');
      if (isEditing) {
        editBtn.className = 'btn btn-primary btn-edit-toggle';
        editBtn.innerHTML = '<span class="material-symbols-outlined">check</span> <span>Listo</span>';
        if (currentViewMode === 'list') {
          card.classList.add('expanded');
        }
      } else {
        editBtn.className = 'btn btn-secondary btn-edit-toggle';
        editBtn.innerHTML = '<span class="material-symbols-outlined">edit</span> <span>Editar</span>';
      }
    });
    
    actionsContainer.appendChild(editBtn);
    body.appendChild(actionsContainer);
  }
  
  card.appendChild(body);
  return card;
}

// Sub-card element for each corrective
function createCorrectiveSubcard(corr, seqNum, equipmentId, isEditor) {
  const subcard = document.createElement('div');
  subcard.className = 'corrective-history-item';
  subcard.dataset.corrId = corr.id;
  
  const header = document.createElement('div');
  header.className = 'corrective-history-header';
  
  const dateSpan = document.createElement('span');
  dateSpan.className = 'corrective-history-date';
  
  // Format creation timestamp
  const dateStr = corr.created_at 
    ? new Date(corr.created_at).toLocaleDateString('es-CR', { year: 'numeric', month: 'short', day: 'numeric' })
    : 'Fecha no registrada';
  dateSpan.innerHTML = `<span class="material-symbols-outlined" style="font-size:14px;">calendar_month</span> Reporte #${seqNum} (${dateStr})`;
  header.appendChild(dateSpan);
  
  // Realizado Badge / Checkbox
  const statusDiv = document.createElement('div');
  statusDiv.className = 'realizado-status-container';
  
  // Read-only static badge (always rendered by default)
  const staticBadge = document.createElement('span');
  if (corr.correctivo_sugerido) {
    if (corr.realizado === 1) {
      staticBadge.className = 'badge-realizado done';
      staticBadge.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;">check_circle</span> Realizado';
    } else {
      staticBadge.className = 'badge-realizado pending';
      staticBadge.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;">pending</span> Pendiente';
    }
  } else {
    staticBadge.className = 'badge-realizado pending';
    staticBadge.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;">remove</span> N/A';
  }
  statusDiv.appendChild(staticBadge);
  
  // Editor checkbox (switches with badge in CSS when .editing class is active on main card)
  if (isEditor) {
    const label = document.createElement('label');
    label.className = 'checkbox-realizado-container';
    
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = corr.realizado === 1;
    input.addEventListener('change', (e) => {
      saveField(corr.id, 'realizado', e.target.checked, false); // false = isEquipmentField
    });
    
    const customCheckbox = document.createElement('span');
    customCheckbox.className = 'checkbox-custom';
    customCheckbox.innerHTML = '<span class="material-symbols-outlined">check</span>';
    
    const textSpan = document.createElement('span');
    textSpan.textContent = 'Realizado';
    
    label.appendChild(input);
    label.appendChild(customCheckbox);
    label.appendChild(textSpan);
    statusDiv.appendChild(label);
    
    // Trash delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-delete-corrective';
    deleteBtn.title = 'Eliminar correctivo';
    deleteBtn.innerHTML = '<span class="material-symbols-outlined">delete</span>';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('¿Estás seguro de que deseas eliminar este correctivo del historial?')) {
        deleteCorrective(corr.id);
      }
    });
    header.appendChild(deleteBtn);
  }
  
  header.appendChild(statusDiv);
  subcard.appendChild(header);
  
  // Fields inside corrective item
  // 1. Correctivo Sugerido
  const fieldCorrectivo = createFieldGroup(
    'correctivo_sugerido',
    'Correctivo Sugerido',
    'build',
    corr.correctivo_sugerido,
    'Describa el correctivo sugerido para este equipo...',
    corr.id,
    isEditor,
    false // isEquipmentField
  );
  subcard.appendChild(fieldCorrectivo);
  
  // 2. Items a Cotizar
  const fieldItems = createFieldGroup(
    'items_a_cotizar',
    'Qué se debe cotizar',
    'shopping_cart',
    corr.items_a_cotizar,
    'Detalle repuestos o servicios a cotizar...',
    corr.id,
    isEditor,
    false // isEquipmentField
  );
  subcard.appendChild(fieldItems);
  
  // 3. Enlace a Cotización (Editor only)
  if (isEditor) {
    const fieldLink = createLinkFieldGroup(corr);
    subcard.appendChild(fieldLink);
  }
  
  return subcard;
}

// Block Field creation helper (supports dual rendering for editor toggle)
function createFieldGroup(fieldKey, labelText, iconName, value, placeholder, itemId, isEditor, isEquipmentField = false) {
  const group = document.createElement('div');
  group.className = 'field-group';
  group.dataset.field = fieldKey;
  
  const label = document.createElement('span');
  label.className = 'field-label';
  label.innerHTML = `<span class="material-symbols-outlined">${iconName}</span> ${labelText}`;
  group.appendChild(label);
  
  const lockIndicator = document.createElement('div');
  lockIndicator.className = 'lock-badge hidden';
  lockIndicator.innerHTML = '<span class="material-symbols-outlined" style="font-size:12px;">lock</span> Editando';
  group.appendChild(lockIndicator);
  
  // Always render read-only representation
  const div = document.createElement('div');
  div.className = `field-value-readonly ${!value ? 'empty' : ''}`;
  div.textContent = value || 'Ninguno';
  group.appendChild(div);
  
  if (isEditor) {
    const textarea = document.createElement('textarea');
    textarea.className = 'field-input';
    textarea.rows = 2;
    textarea.placeholder = placeholder;
    textarea.value = value || '';
    
    textarea.addEventListener('focus', () => sendLock(itemId, fieldKey));
    textarea.addEventListener('input', (e) => debounceSave(itemId, fieldKey, e.target.value, isEquipmentField));
    textarea.addEventListener('blur', (e) => {
      sendUnlock(itemId, fieldKey);
      triggerImmediateSave(itemId, fieldKey, e.target.value, isEquipmentField);
    });
    
    group.appendChild(textarea);
  }
  
  return group;
}

// Inline Field creation helper (For Capacidad)
function createFieldGroupInline(fieldKey, labelText, iconName, value, placeholder, itemId, isEditor, isEquipmentField = true) {
  const group = document.createElement('div');
  group.className = 'field-group';
  group.dataset.field = fieldKey;
  
  const label = document.createElement('span');
  label.className = 'field-label';
  label.innerHTML = `<span class="material-symbols-outlined">${iconName}</span> ${labelText}`;
  group.appendChild(label);
  
  const lockIndicator = document.createElement('div');
  lockIndicator.className = 'lock-badge hidden';
  lockIndicator.innerHTML = '<span class="material-symbols-outlined" style="font-size:12px;">lock</span>';
  group.appendChild(lockIndicator);
  
  const div = document.createElement('div');
  div.className = `field-value-readonly ${!value ? 'empty' : ''}`;
  div.textContent = value || 'No registrada';
  group.appendChild(div);
  
  if (isEditor) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'field-input';
    input.placeholder = placeholder;
    input.value = value || '';
    
    input.addEventListener('focus', () => sendLock(itemId, fieldKey));
    input.addEventListener('input', (e) => debounceSave(itemId, fieldKey, e.target.value, isEquipmentField));
    input.addEventListener('blur', (e) => {
      sendUnlock(itemId, fieldKey);
      triggerImmediateSave(itemId, fieldKey, e.target.value, isEquipmentField);
    });
    
    group.appendChild(input);
  }
  
  return group;
}

// Link Field group for Editors
function createLinkFieldGroup(corr) {
  const group = document.createElement('div');
  group.className = 'field-group';
  group.dataset.field = 'link_cotizacion';
  
  const label = document.createElement('span');
  label.className = 'field-label';
  label.innerHTML = '<span class="material-symbols-outlined">link</span> Enlace a Cotización';
  group.appendChild(label);
  
  const lockIndicator = document.createElement('div');
  lockIndicator.className = 'lock-badge hidden';
  lockIndicator.innerHTML = '<span class="material-symbols-outlined" style="font-size:12px;">lock</span>';
  group.appendChild(lockIndicator);
  
  // Read-only link representation
  const readOnlyLink = document.createElement('a');
  readOnlyLink.className = `read-only-link ${!corr.link_cotizacion ? 'empty' : ''}`;
  readOnlyLink.href = corr.link_cotizacion || '#';
  readOnlyLink.target = '_blank';
  readOnlyLink.innerHTML = corr.link_cotizacion 
    ? '<span class="material-symbols-outlined" style="font-size:16px;">open_in_new</span> Ver Cotización' 
    : 'Ninguna';
  group.appendChild(readOnlyLink);
  
  // Editable link group
  const linkRow = document.createElement('div');
  linkRow.className = 'quote-link-group';
  
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'field-input';
  input.placeholder = 'https://enlace-cotizacion.com';
  input.value = corr.link_cotizacion || '';
  
  input.addEventListener('focus', () => sendLock(corr.id, 'link_cotizacion'));
  input.addEventListener('input', (e) => debounceSave(corr.id, 'link_cotizacion', e.target.value, false));
  input.addEventListener('blur', (e) => {
    sendUnlock(corr.id, 'link_cotizacion');
    triggerImmediateSave(corr.id, 'link_cotizacion', e.target.value, false);
  });
  
  linkRow.appendChild(input);
  
  const linkBtn = document.createElement('a');
  linkBtn.className = `btn btn-text icon-only ${!corr.link_cotizacion ? 'hidden' : ''}`;
  linkBtn.href = corr.link_cotizacion || '#';
  linkBtn.target = '_blank';
  linkBtn.title = 'Ir a la cotización';
  linkBtn.innerHTML = '<span class="material-symbols-outlined">open_in_new</span>';
  linkRow.appendChild(linkBtn);
  
  group.appendChild(linkRow);
  return group;
}

// Auto-saving functions (REST PUT)
function debounceSave(itemId, field, value, isEquipmentField) {
  const key = `${itemId}-${field}`;
  
  if (debounceTimers[key]) {
    clearTimeout(debounceTimers[key]);
  }
  
  debounceTimers[key] = setTimeout(() => {
    saveField(itemId, field, value, isEquipmentField);
    delete debounceTimers[key];
  }, 600);
}

function triggerImmediateSave(itemId, field, value, isEquipmentField) {
  const key = `${itemId}-${field}`;
  if (debounceTimers[key]) {
    clearTimeout(debounceTimers[key]);
    delete debounceTimers[key];
    saveField(itemId, field, value, isEquipmentField);
  }
}

async function saveField(itemId, field, value, isEquipmentField) {
  if (currentRole !== 'editor') return;
  
  const payload = {};
  payload[field] = value;
  
  // Switch endpoints based on whether we update equipment metadata (capacity) or a specific corrective
  const url = isEquipmentField ? `/api/equipos/${itemId}` : `/api/correctivos/${itemId}`;
  
  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': currentToken
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      if (response.status === 401) {
        logout();
        return;
      }
      throw new Error('Error al guardar');
    }
    
    const result = await response.json();
    
    // Update local state array
    const updatedEq = result.data;
    const idx = equipos.findIndex(item => item.id === updatedEq.id);
    if (idx !== -1) {
      equipos[idx] = updatedEq;
      calculateStats();
      
      // Update link UI if needed
      if (!isEquipmentField && field === 'link_cotizacion') {
        const cardEl = document.querySelector(`.equip-card[data-id="${updatedEq.id}"]`);
        if (cardEl) {
          const subcard = cardEl.querySelector(`.corrective-history-item[data-corr-id="${itemId}"]`);
          if (subcard) {
            const linkBtn = subcard.querySelector('.quote-link-group a');
            if (linkBtn) {
              if (value) {
                linkBtn.href = value;
                linkBtn.classList.remove('hidden');
              } else {
                linkBtn.classList.add('hidden');
              }
            }
            const readOnlyLink = subcard.querySelector('.read-only-link');
            if (readOnlyLink) {
              if (value) {
                readOnlyLink.href = value;
                readOnlyLink.classList.remove('empty');
                readOnlyLink.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;">open_in_new</span> Ver Cotización';
              } else {
                readOnlyLink.href = '#';
                readOnlyLink.classList.add('empty');
                readOnlyLink.textContent = 'Ninguna';
              }
            }
          }
        }
      }
      
      // Update graphs
      renderCharts();
    }
  } catch (error) {
    console.error('Error saving field:', error);
  }
}

// Add new corrective (REST POST)
async function addCorrective(equipmentId) {
  if (currentRole !== 'editor') return;
  
  try {
    const response = await fetch('/api/correctivos', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': currentToken
      },
      body: JSON.stringify({ equipo_id: equipmentId })
    });
    
    if (!response.ok) {
      throw new Error('No se pudo agregar el correctivo');
    }
    
    const result = await response.json();
    const updatedEq = result.data;
    
    // Update local state and redraw card
    const idx = equipos.findIndex(item => item.id === equipmentId);
    if (idx !== -1) {
      equipos[idx] = updatedEq;
      calculateStats();
      
      const cardEl = document.querySelector(`.equip-card[data-id="${equipmentId}"]`);
      if (cardEl) {
        // Redraw this card's correctives history container dynamically
        const historyContainer = cardEl.querySelector('.corrective-history-container');
        if (historyContainer) {
          historyContainer.innerHTML = '';
          const validCorrectives = (updatedEq.correctivos || []);
          validCorrectives.forEach((corr, index) => {
            const corrCard = createCorrectiveSubcard(corr, index + 1, updatedEq.id, true);
            historyContainer.appendChild(corrCard);
          });
          
          // Re-append add button
          const addBtn = document.createElement('button');
          addBtn.className = 'btn-add-corrective';
          addBtn.innerHTML = '<span class="material-symbols-outlined">add_circle</span> Agregar Correctivo';
          addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            addCorrective(updatedEq.id);
          });
          historyContainer.appendChild(addBtn);
        }
        
        // Auto-add .editing class to keep inputs editable after creation
        cardEl.classList.add('editing');
        const editBtn = cardEl.querySelector('.btn-edit-toggle');
        if (editBtn) {
          editBtn.className = 'btn btn-primary btn-edit-toggle';
          editBtn.innerHTML = '<span class="material-symbols-outlined">check</span> <span>Listo</span>';
        }
      }
      
      renderCharts();
    }
  } catch (error) {
    console.error('Error adding corrective:', error);
  }
}

// Delete corrective (REST DELETE)
async function deleteCorrective(correctiveId) {
  if (currentRole !== 'editor') return;
  
  try {
    const response = await fetch(`/api/correctivos/${correctiveId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': currentToken
      }
    });
    
    if (!response.ok) {
      throw new Error('No se pudo eliminar el correctivo');
    }
    
    const result = await response.json();
    const updatedEq = result.data;
    
    // Update local state and redraw card
    const idx = equipos.findIndex(item => item.id === updatedEq.id);
    if (idx !== -1) {
      equipos[idx] = updatedEq;
      calculateStats();
      
      const cardEl = document.querySelector(`.equip-card[data-id="${updatedEq.id}"]`);
      if (cardEl) {
        const historyContainer = cardEl.querySelector('.corrective-history-container');
        if (historyContainer) {
          historyContainer.innerHTML = '';
          const validCorrectives = (updatedEq.correctivos || []);
          if (validCorrectives.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.className = 'field-value-readonly empty';
            emptyMsg.textContent = 'Sin correctivos registrados';
            historyContainer.appendChild(emptyMsg);
          } else {
            validCorrectives.forEach((corr, index) => {
              const corrCard = createCorrectiveSubcard(corr, index + 1, updatedEq.id, true);
              historyContainer.appendChild(corrCard);
            });
          }
          
          // Re-append add button
          const addBtn = document.createElement('button');
          addBtn.className = 'btn-add-corrective';
          addBtn.innerHTML = '<span class="material-symbols-outlined">add_circle</span> Agregar Correctivo';
          addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            addCorrective(updatedEq.id);
          });
          historyContainer.appendChild(addBtn);
        }
        
        // Auto-add .editing class to keep inputs editable after creation
        cardEl.classList.add('editing');
        const editBtn = cardEl.querySelector('.btn-edit-toggle');
        if (editBtn) {
          editBtn.className = 'btn btn-primary btn-edit-toggle';
          editBtn.innerHTML = '<span class="material-symbols-outlined">check</span> <span>Listo</span>';
        }
      }
      
      renderCharts();
    }
  } catch (error) {
    console.error('Error deleting corrective:', error);
  }
}

// View switcher setter
function setViewMode(mode) {
  currentViewMode = mode;
  localStorage.setItem('cocesna_view_mode', mode);
  
  if (btnViewGrid && btnViewList) {
    if (mode === 'grid') {
      btnViewGrid.classList.add('active');
      btnViewList.classList.remove('active');
      equipmentGrid.classList.remove('list-view');
    } else {
      btnViewGrid.classList.remove('active');
      btnViewList.classList.add('active');
      equipmentGrid.classList.add('list-view');
    }
  }
  renderEquipos();
}

// Toggle Analytics display
function toggleAnalytics() {
  currentShowAnalytics = !currentShowAnalytics;
  if (currentShowAnalytics) {
    analyticsPanel.classList.remove('hidden');
    btnToggleAnalytics.classList.add('active');
    setTimeout(renderCharts, 50);
  } else {
    analyticsPanel.classList.add('hidden');
    btnToggleAnalytics.classList.remove('active');
    destroyCharts();
  }
}

function destroyCharts() {
  Object.values(charts).forEach(chart => {
    if (chart) chart.destroy();
  });
  charts = {};
}

// Chart.js render engine (calculates stats on filtered list)
function renderCharts() {
  if (!currentShowAnalytics) return;
  
  const filtered = getFilteredEquipos();
  
  let totalCorrectivos = 0;
  let realizados = 0;
  let pendientes = 0;
  
  const bySede = {};
  const byZona = { 'GAM': 0, 'Foráneo': 0 };
  
  filtered.forEach(eq => {
    const list = eq.correctivos || [];
    list.forEach(c => {
      if (!c.correctivo_sugerido) return;
      totalCorrectivos++;
      if (c.realizado === 1) realizados++;
      else pendientes++;
      
      bySede[eq.sede] = (bySede[eq.sede] || 0) + 1;
      if (eq.zona in byZona) {
        byZona[eq.zona]++;
      }
    });
  });
  
  destroyCharts();
  
  // Chart 1: Progress (Doughnut)
  const ctxProgress = document.getElementById('chart-progress');
  if (ctxProgress) {
    charts.progress = new Chart(ctxProgress, {
      type: 'doughnut',
      data: {
        labels: ['Realizados', 'Pendientes'],
        datasets: [{
          data: [realizados, pendientes],
          backgroundColor: ['#6BB54E', '#2167AF'],
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom' }
        }
      }
    });
  }
  
  // Chart 2: Sede (Horizontal Bar)
  const ctxSede = document.getElementById('chart-sede');
  if (ctxSede) {
    const labels = Object.keys(bySede);
    const values = Object.values(bySede);
    
    charts.sede = new Chart(ctxSede, {
      type: 'bar',
      data: {
        labels: labels.length ? labels : ['Ninguna'],
        datasets: [{
          label: 'Correctivos',
          data: values.length ? values : [0],
          backgroundColor: '#1E97D1',
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: { ticks: { stepSize: 1, precision: 0 } }
        }
      }
    });
  }
  
  // Chart 3: Zona (Pie)
  const ctxZona = document.getElementById('chart-zona');
  if (ctxZona) {
    charts.zona = new Chart(ctxZona, {
      type: 'pie',
      data: {
        labels: ['GAM', 'Foráneo'],
        datasets: [{
          data: [byZona['GAM'], byZona['Foráneo']],
          backgroundColor: ['#2167AF', '#E08E2E'],
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom' }
        }
      }
    });
  }
}

// jsPDF report generator (compiles only filtered data)
function exportToPDF() {
  const filtered = getFilteredEquipos();
  if (filtered.length === 0) {
    alert("No hay equipos para exportar con la selección de filtros actual.");
    return;
  }
  
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  
  // Header Accent Banner (Eco Ingeniería CR Primary Dark Blue)
  doc.setFillColor(33, 103, 175); // #2167AF
  doc.rect(14, 15, 182, 8, 'F');
  
  doc.setFont("Helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(33, 103, 175);
  doc.text("ECO INGENIERÍA CR", 14, 34);
  
  doc.setFont("Helvetica", "normal");
  doc.setFontSize(12);
  doc.setTextColor(100, 100, 100);
  doc.text("Reporte de Mantenimiento Correctivo - HVAC", 14, 40);
  
  // Info details block
  doc.setFontSize(9);
  doc.setTextColor(120, 120, 120);
  const dateStr = new Date().toLocaleDateString('es-CR', { year: 'numeric', month: 'long', day: 'numeric' });
  doc.text(`Fecha de emisión: ${dateStr}`, 14, 48);
  
  const activeSede = filterSede.value || 'Todas las sedes';
  const activeZona = filterZona.value || 'Todas las zonas';
  doc.text(`Filtros activos - Sede: ${activeSede} | Zona: ${activeZona}`, 14, 53);
  
  // Format table rows
  const tableRows = [];
  filtered.forEach(eq => {
    const list = eq.correctivos || [];
    const valid = list.filter(c => c.correctivo_sugerido);
    
    if (valid.length === 0) {
      // Include equipment showing empty corrective state
      tableRows.push([
        eq.sede,
        eq.edificio,
        `${eq.equipo} (#${eq.numero_equipo || ''})`,
        eq.capacidad || 'N/R',
        'Sin correctivos reportados',
        'N/A',
        'Realizado'
      ]);
    } else {
      valid.forEach((c, idx) => {
        tableRows.push([
          idx === 0 ? eq.sede : '',
          idx === 0 ? eq.edificio : '',
          idx === 0 ? `${eq.equipo} (#${eq.numero_equipo || ''})` : '',
          idx === 0 ? (eq.capacidad || 'N/R') : '',
          c.correctivo_sugerido,
          c.items_a_cotizar || 'Ninguno',
          c.realizado === 1 ? 'Realizado' : 'Pendiente'
        ]);
      });
    }
  });
  
  // Compile Table
  doc.autoTable({
    startY: 58,
    head: [['Sede', 'Edificio', 'Equipo', 'Capacidad', 'Correctivo Sugerido', 'Repuestos a Cotizar', 'Estado']],
    body: tableRows,
    headStyles: { fillColor: [33, 103, 175], textColor: [255, 255, 255], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [245, 249, 253] },
    margin: { top: 15 },
    styles: { font: "Helvetica", fontSize: 7.5, cellPadding: 3 },
    columnStyles: {
      4: { cellWidth: 48 }, // Correctivo
      5: { cellWidth: 35 }  // Repuestos
    }
  });
  
  const safeSede = activeSede.replace(/\s+/g, '_');
  doc.save(`Reporte_Correctivos_EcoIngenieria_${safeSede}.pdf`);
}

// WebSocket Real-time Sync
function startWebSocket() {
  stopWebSocket();
  
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  
  console.log(`Connecting to WebSocket at ${wsUrl}`);
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    console.log('WebSocket connected.');
    connBanner.classList.add('hidden');
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
  };
  
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      
      switch (msg.type) {
        case 'initial_locks':
          activeLocks = msg.locks;
          applyLocksUI();
          break;
          
        case 'lock':
          activeLocks[`${msg.id}-${msg.field}`] = msg.clientId;
          setFieldLockState(msg.id, msg.field, true);
          break;
          
        case 'unlock':
          delete activeLocks[`${msg.id}-${msg.field}`];
          setFieldLockState(msg.id, msg.field, false);
          break;
          
        case 'update':
          handleRemoteUpdate(msg.data);
          break;
      }
    } catch (e) {
      console.error('WS message error:', e);
    }
  };
  
  ws.onclose = () => {
    console.log('WebSocket disconnected.');
    connBanner.classList.remove('hidden');
    activeLocks = {};
    applyLocksUI();
    wsReconnectTimer = setTimeout(startWebSocket, 3000);
  };
  
  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };
}

function stopWebSocket() {
  if (ws) {
    ws.close();
    ws = null;
  }
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
}

function sendLock(itemId, field) {
  if (ws && ws.readyState === WebSocket.OPEN && currentRole === 'editor') {
    ws.send(JSON.stringify({
      type: 'lock',
      id: itemId,
      field: field
    }));
  }
}

function sendUnlock(itemId, field) {
  if (ws && ws.readyState === WebSocket.OPEN && currentRole === 'editor') {
    ws.send(JSON.stringify({
      type: 'unlock',
      id: itemId,
      field: field
    }));
  }
}

function applyLocksUI() {
  document.querySelectorAll('.field-input').forEach(el => {
    el.classList.remove('locked');
    el.removeAttribute('disabled');
  });
  document.querySelectorAll('.lock-badge').forEach(el => {
    el.classList.add('hidden');
  });
  
  for (const key of Object.keys(activeLocks)) {
    const [id, field] = key.split('-');
    setFieldLockState(id, field, true);
  }
}

function setFieldLockState(itemId, field, isLocked) {
  // Find group by searching elements globally (could belong to any corrective subcard or capacity field)
  const groups = document.querySelectorAll(`.field-group[data-field="${field}"]`);
  groups.forEach(fieldGroup => {
    // Check if parent card or subcard matches the itemId (corrective ID or equipment ID)
    const cardEl = fieldGroup.closest('.equip-card');
    const subcardEl = fieldGroup.closest('.corrective-history-item');
    
    const isMatchingEquipment = (field === 'capacidad' && cardEl && cardEl.dataset.id === String(itemId));
    const isMatchingCorrective = (field !== 'capacidad' && subcardEl && subcardEl.dataset.corrId === String(itemId));
    
    if (isMatchingEquipment || isMatchingCorrective) {
      const inputEl = fieldGroup.querySelector('.field-input');
      const badgeEl = fieldGroup.querySelector('.lock-badge');
      
      if (isLocked) {
        if (inputEl && document.activeElement !== inputEl) {
          inputEl.classList.add('locked');
          inputEl.setAttribute('disabled', 'true');
          if (badgeEl) badgeEl.classList.remove('hidden');
        }
      } else {
        if (inputEl) {
          inputEl.classList.remove('locked');
          inputEl.removeAttribute('disabled');
        }
        if (badgeEl) badgeEl.classList.add('hidden');
      }
    }
  });
}

// Remote update processing (rebuilds target cards to preserve edits/states gracefully)
function handleRemoteUpdate(updatedItem) {
  const idx = equipos.findIndex(item => item.id === updatedItem.id);
  if (idx !== -1) {
    const oldItem = equipos[idx];
    equipos[idx] = updatedItem;
    calculateStats();
    
    const cardEl = document.querySelector(`.equip-card[data-id="${updatedItem.id}"]`);
    if (cardEl) {
      // 1. Update static header badges (reincidencia) if they changed
      const oldCorrCount = (oldItem.correctivos || []).filter(c => c.correctivo_sugerido).length;
      const newCorrCount = (updatedItem.correctivos || []).filter(c => c.correctivo_sugerido).length;
      
      if (oldCorrCount !== newCorrCount) {
        const badgeRow = cardEl.querySelector('.badge-row');
        if (badgeRow) {
          // Remove old reincidencia badges
          const oldMedia = badgeRow.querySelector('.badge-reincidencia-media');
          const oldAlta = badgeRow.querySelector('.badge-reincidencia-alta');
          if (oldMedia) oldMedia.remove();
          if (oldAlta) oldAlta.remove();
          
          // Add new badge
          if (newCorrCount === 2) {
            const rBadge = document.createElement('span');
            rBadge.className = 'badge-reincidencia-media';
            rBadge.innerHTML = '<span class="material-symbols-outlined" style="font-size:12px;">info</span> Reincidencia: 2';
            badgeRow.appendChild(rBadge);
          } else if (newCorrCount >= 3) {
            const rBadge = document.createElement('span');
            rBadge.className = 'badge-reincidencia-alta';
            rBadge.innerHTML = `<span class="material-symbols-outlined" style="font-size:12px;">warning</span> Reincidencia: ${newCorrCount}`;
            badgeRow.appendChild(rBadge);
          }
        }
      }
      
      // 2. Sync equipment properties (Capacity)
      updateFieldDOM(cardEl, 'capacidad', updatedItem.capacidad);
      
      // 3. Update correctives elements (sync inputs and read-only labels inside sub-cards)
      const validCorrectives = updatedItem.correctivos || [];
      const historyContainer = cardEl.querySelector('.corrective-history-container');
      
      if (historyContainer) {
        // Check if correctives count changed. If so, redraw history subcards completely
        const currentSubcards = historyContainer.querySelectorAll('.corrective-history-item');
        if (currentSubcards.length !== validCorrectives.length) {
          const isEditing = cardEl.classList.contains('editing');
          historyContainer.innerHTML = '';
          
          if (validCorrectives.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.className = 'field-value-readonly empty';
            emptyMsg.textContent = 'Sin correctivos registrados';
            historyContainer.appendChild(emptyMsg);
          } else {
            validCorrectives.forEach((corr, index) => {
              const corrCard = createCorrectiveSubcard(corr, index + 1, updatedItem.id, currentRole === 'editor');
              historyContainer.appendChild(corrCard);
            });
          }
          
          if (currentRole === 'editor') {
            const addBtn = document.createElement('button');
            addBtn.className = 'btn-add-corrective';
            addBtn.innerHTML = '<span class="material-symbols-outlined">add_circle</span> Agregar Correctivo';
            addBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              addCorrective(updatedItem.id);
            });
            historyContainer.appendChild(addBtn);
          }
          
          // Re-apply editing class state to child nodes if main card is editing
          if (isEditing) {
            cardEl.classList.add('editing');
          }
        } else {
          // If length matches, surgically update fields for each corrective sub-card
          validCorrectives.forEach(corr => {
            const subcard = historyContainer.querySelector(`.corrective-history-item[data-corr-id="${corr.id}"]`);
            if (subcard) {
              // Update Done check/badge
              const chkEl = subcard.querySelector('.checkbox-realizado-container input');
              if (chkEl && document.activeElement !== chkEl) {
                chkEl.checked = corr.realizado === 1;
              }
              
              const badgeEl = subcard.querySelector('.badge-realizado');
              if (badgeEl) {
                if (corr.correctivo_sugerido) {
                  if (corr.realizado === 1) {
                    badgeEl.className = 'badge-realizado done';
                    badgeEl.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;">check_circle</span> Realizado';
                  } else {
                    badgeEl.className = 'badge-realizado pending';
                    badgeEl.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;">pending</span> Pendiente';
                  }
                } else {
                  badgeEl.className = 'badge-realizado pending';
                  badgeEl.innerHTML = '<span class="material-symbols-outlined" style="font-size:14px;">remove</span> N/A';
                }
              }
              
              // Update text fields
              updateFieldDOM(subcard, 'correctivo_sugerido', corr.correctivo_sugerido);
              updateFieldDOM(subcard, 'items_a_cotizar', corr.items_a_cotizar);
              
              // Update link cotizacion
              const linkInput = subcard.querySelector('.quote-link-group input');
              const linkBtn = subcard.querySelector('.quote-link-group a');
              const readOnlyLink = subcard.querySelector('.read-only-link');
              
              if (linkInput && document.activeElement !== linkInput) {
                linkInput.value = corr.link_cotizacion || '';
              }
              if (linkBtn) {
                if (corr.link_cotizacion) {
                  linkBtn.href = corr.link_cotizacion;
                  linkBtn.classList.remove('hidden');
                } else {
                  linkBtn.classList.add('hidden');
                }
              }
              if (readOnlyLink) {
                if (corr.link_cotizacion) {
                  readOnlyLink.href = corr.link_cotizacion;
                  readOnlyLink.classList.remove('empty');
                  readOnlyLink.innerHTML = '<span class="material-symbols-outlined" style="font-size:16px;">open_in_new</span> Ver Cotización';
                } else {
                  readOnlyLink.href = '#';
                  readOnlyLink.classList.add('empty');
                  readOnlyLink.textContent = 'Ninguna';
                }
              }
            }
          });
        }
      }
    }
    
    // Update active graphs
    renderCharts();
  }
}

function updateFieldDOM(containerEl, field, value) {
  const group = containerEl.querySelector(`.field-group[data-field="${field}"]`);
  if (!group) return;
  
  const input = group.querySelector('.field-input');
  if (input && document.activeElement !== input) {
    input.value = value || '';
  }
  
  const readOnlyDiv = group.querySelector('.field-value-readonly');
  if (readOnlyDiv) {
    if (field === 'capacidad') {
      readOnlyDiv.textContent = value || 'No registrada';
    } else {
      readOnlyDiv.textContent = value || 'Ninguno';
    }
    if (!value) {
      readOnlyDiv.classList.add('empty');
    } else {
      readOnlyDiv.classList.remove('empty');
    }
  }
}

// Start application
window.addEventListener('DOMContentLoaded', init);
