import { useState, useEffect, useMemo, useCallback, useRef, Fragment } from 'react'

// --- Tenant ID → Name mapping ---
const TENANT_MAP = {
  62: 'TikTok-Video-ContentClassification',
  65: 'Live-Livestream-General',
  119: 'PhotoPost',
  45: 'TikTok-Comment-General',
  47: 'TikTok-Effect-General',
  55: 'TikTok-Hashtag-General',
  72: 'TikTok-Link-General',
  36: 'TikTok-Message-General',
  118: 'TikTok-PhotoComment-General',
  84: 'TikTok-User Profile-Policy 4.0',
  10: 'M&T-Audio-General',
}

const TENANT_IDS = Object.keys(TENANT_MAP).map(Number)

// --- Cookie storage key ---
const COOKIE_STORAGE_KEY = 'pms_session_cookie'

function getSavedCookie() {
  try { return localStorage.getItem(COOKIE_STORAGE_KEY) || '' } catch { return '' }
}

function saveCookie(cookie) {
  try { localStorage.setItem(COOKIE_STORAGE_KEY, cookie) } catch { /* ignore */ }
}

// --- API fetch helpers ---

async function fetchTenantList(tenantId, cookie) {
  const headers = {
    'Content-Type': 'application/json',
    'Tenant': String(tenantId),
  }
  if (cookie) headers['X-PMS-Cookie'] = cookie
  const res = await fetch('/gateway/policy/search/v2', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      param: { filter: { level: [] } },
      returnConfig: { page: 1, limit: 99999, highLightConfig: { fragmentSize: 200 } },
    }),
  })
  if (!res.ok) throw new Error(`List API failed for tenant ${tenantId}: ${res.status}`)
  const json = await res.json()
  if (json.code === 401) throw new Error('AUTH_REQUIRED')
  return json.data?.data || []
}

async function fetchPolicyDetail(regionPolicyID, tenantId, cookie) {
  const headers = { 'Tenant': String(tenantId) }
  if (cookie) headers['X-PMS-Cookie'] = cookie
  const res = await fetch(`/api/cms/v3/policy/get_region_policy_by_id?id=${regionPolicyID}&languageCodes=en`, { headers })
  if (!res.ok) throw new Error(`Detail API failed for ${regionPolicyID}: ${res.status}`)
  const json = await res.json()
  if (json.code === 401) throw new Error('AUTH_REQUIRED')
  return json.data || {}
}

// --- Transform detail response → flat entries matching current format ---

function transformDetailToEntries(detailData, tenantId, tenantName, listItem) {
  const entries = []
  const regions = detailData.regions || {}
  for (const [regionName, regionData] of Object.entries(regions)) {
    const results = regionData.condition_results || {}
    const ageGroup = results['Age Group']
    const entry = {
      policy_title: listItem.title,
      policy_code: listItem.uid || detailData.uid || '',
      region: regionName,
      cat0: listItem.categoryCodes?.[0] || '',
      cat1: listItem.categoryCodes?.[1] || '',
      labels: listItem.labels || [],
      level: detailData.level || '',
      results: results,
      adult_action: ageGroup?.Adult?.Action || results?.Action || '',
      late_teen_action: ageGroup?.['Late teen']?.Action || '',
      early_teen_action: ageGroup?.['Early teen']?.Action || '',
      children_action: ageGroup?.Children?.Action || '',
      tenant_id: tenantId,
      tenant_name: tenantName,
    }
    entries.push(entry)
  }
  return entries
}

// --- Batch concurrent requests with concurrency limit ---

async function batchFetch(items, fn, concurrency, onProgress) {
  const results = []
  let completed = 0
  let idx = 0

  async function worker() {
    while (idx < items.length) {
      const i = idx++
      try {
        results[i] = await fn(items[i], i)
      } catch (err) {
        console.warn('Batch fetch error:', err)
        results[i] = null
      }
      completed++
      if (onProgress) onProgress(completed, items.length)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

// --- Detail cache (preserved for lazy detail fetch from modal) ---

const detailCache = {}

async function fetchDetail(id) {
  if (detailCache[id]) return detailCache[id]
  // In live mode, we don't have batch files. Return null — details are already in the data.
  return null
}

// --- Fuzzy title grouping utilities (preserved) ---

function normalizeForGrouping(title) {
  let norm = title.replace(/\[.*?\]/g, '').trim()
  norm = norm.toLowerCase().replace(/\s+/g, ' ').trim()
  return norm || title.toLowerCase().trim()
}

function wordTokens(str) {
  return str.split(/[\s\-–—,;:()\/]+/).filter(w => w.length > 1)
}

function jaccardSimilarity(a, b) {
  const setA = new Set(a)
  const setB = new Set(b)
  let intersection = 0
  for (const w of setA) { if (setB.has(w)) intersection++ }
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 0 : intersection / union
}

function isBorderline(entry) {
  return (entry.labels || []).some(l => l.toLowerCase().includes('borderline'))
}

function buildFuzzyGroups(data) {
  const normMap = new Map()
  for (const entry of data) {
    const borderlineSuffix = isBorderline(entry) ? '||borderline' : ''
    const norm = normalizeForGrouping(entry.policy_title) + borderlineSuffix
    if (!normMap.has(norm)) normMap.set(norm, [])
    normMap.get(norm).push(entry)
  }

  const normKeys = [...normMap.keys()]
  const tokenSets = normKeys.map(k => wordTokens(k))

  const parent = normKeys.map((_, i) => i)
  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] }
    return i
  }
  function unite(a, b) {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  const blocks = new Map()
  for (let i = 0; i < normKeys.length; i++) {
    const words = tokenSets[i]
    const keys = new Set()
    if (words.length > 0) keys.add(words[0])
    if (words.length > 1) keys.add(words[1])
    for (const w of words) { if (w.length > 5) keys.add(w) }
    for (const bk of keys) {
      if (!blocks.has(bk)) blocks.set(bk, [])
      blocks.get(bk).push(i)
    }
  }

  for (const indices of blocks.values()) {
    if (indices.length > 200) continue
    for (let i = 0; i < indices.length; i++) {
      for (let j = i + 1; j < indices.length; j++) {
        if (find(indices[i]) === find(indices[j])) continue
        const iBorder = normKeys[indices[i]].endsWith('||borderline')
        const jBorder = normKeys[indices[j]].endsWith('||borderline')
        if (iBorder !== jBorder) continue
        const sim = jaccardSimilarity(tokenSets[indices[i]], tokenSets[indices[j]])
        if (sim >= 0.75) {
          unite(indices[i], indices[j])
        }
      }
    }
  }

  const mergedMap = new Map()
  for (let i = 0; i < normKeys.length; i++) {
    const root = find(i)
    if (!mergedMap.has(root)) mergedMap.set(root, [])
    mergedMap.get(root).push(...normMap.get(normKeys[i]))
  }

  const result = new Map()
  for (const [root, entries] of mergedMap) {
    const counts = {}
    for (const e of entries) {
      counts[e.policy_title] = (counts[e.policy_title] || 0) + 1
    }
    let label = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    if (normKeys[root].endsWith('||borderline')) {
      label += ' (Borderline)'
    }
    result.set(label, entries)
  }
  return result
}

// --- Action display helpers (updated colour groupings) ---

function actionClass(val) {
  if (!val) return 'empty'
  const lower = val.toLowerCase()
  if (lower.includes('violation') || lower === 'ban' || lower === 'interrupt' || lower.includes('remove') || lower === 'lv1') return 'violation'
  if (lower.includes('not recommend') || lower.includes('not rec') || lower.includes('restrict') || lower === 'lv2') return 'not-recommend'
  if (lower.includes('suspend') || lower.includes('deboost') || lower.includes('pending')) return 'suspend'
  if (lower.includes('reset') || lower.includes('not for feed') || lower === 'not ff' || lower === 'lv3') return 'reset'
  if (lower.includes('allow') || lower.includes('approve') || lower === 'general') return 'allow'
  return ''
}

function actionShort(val) {
  if (!val) return '\u2014'
  const lower = val.toLowerCase()
  if (lower.includes('violation')) return 'Viol'
  if (lower === 'ban') return 'Ban'
  if (lower === 'interrupt') return 'Intrpt'
  if (lower.includes('remove')) return 'Remove'
  if (lower === 'lv1') return 'LV1'
  if (lower === 'lv2') return 'LV2'
  if (lower === 'lv3') return 'LV3'
  if (lower.includes('not recommend')) return 'NotRec'
  if (lower.includes('not rec')) return 'NotRec'
  if (lower.includes('regional not')) return 'RgnNR'
  if (lower.includes('restrict')) return 'Restrict'
  if (lower.includes('not for feed')) return 'NotFF'
  if (lower.includes('suspend')) return 'Suspend'
  if (lower.includes('deboost')) return 'Deboost'
  if (lower.includes('pending')) return 'Pending'
  if (lower.includes('reset')) return 'Reset'
  if (lower.includes('allow')) return 'Allow'
  if (lower.includes('approve')) return 'Approve'
  if (lower === 'general') return 'General'
  return val.length > 8 ? val.slice(0, 8) + '\u2026' : val
}

function mode(arr) {
  const counts = {}
  for (const v of arr) {
    const key = v || ''
    counts[key] = (counts[key] || 0) + 1
  }
  let best = '', bestCount = 0
  for (const [k, c] of Object.entries(counts)) {
    if (c > bestCount) { best = k; bestCount = c }
  }
  return best
}

function ActionBadge({ value }) {
  const cls = actionClass(value)
  return (
    <span className={`action-badge ${cls}`} title={value || 'None'}>
      {actionShort(value)}
    </span>
  )
}

// --- Shortened tenant names (#8) ---
const TENANT_SHORT_NAMES = {
  'TikTok-Video-ContentClassification': 'Video',
  'Live-Livestream-General': 'Live',
  'PhotoPost': 'Photo',
  'TikTok-Comment-General': 'Comment',
  'TikTok-Effect-General': 'Effect',
  'TikTok-Hashtag-General': 'Hashtag',
  'TikTok-Link-General': 'Link',
  'TikTok-Message-General': 'Message',
  'TikTok-PhotoComment-General': 'PhotoComment',
  'TikTok-User Profile-Policy 4.0': 'UserProfile',
  'M&T-Audio-General': 'Audio',
}

function shortTenant(name) {
  return TENANT_SHORT_NAMES[name] || name
}

// Default column order (#3)
const DEFAULT_TENANT_ORDER = [
  'TikTok-Video-ContentClassification',
  'Live-Livestream-General',
  'PhotoPost',
  'TikTok-Comment-General',
]

// Main verticals categories (#5) — ordered for default display
const MAIN_VERTICAL_ORDER = [
  'Violent Behaviors & Dangerous Actors',
  'Exploitation & Abuse',
  'Harassment & Hateful Behavior',
  'Harassment & Hateful  Behavior',
  'Nudity & Sexual Activity',
  'Mental Health',
  'Shocking & Graphic Content',
  'High Risk & Regulated Activities',
  'High-Risk & Regulated Activities',
  'Harmful Misinformation',
  'Deceptive Behaviors',
  'Civic Integrity',
]
const MAIN_VERTICAL_CATEGORIES = new Set(MAIN_VERTICAL_ORDER)

// --- New helpers ---

// #7: For Video-ContentClassification use adult_action; for others use fallback chain
function getPrimaryAction(entry) {
  if (entry.tenant_name === 'TikTok-Video-ContentClassification') {
    if (entry.adult_action) return entry.adult_action
  }
  if (entry.adult_action) return entry.adult_action
  const r = entry.results
  if (!r) return ''
  if (r.Action) return r.Action
  if (r.action_audio) return r.action_audio
  if (r.live && r.live.Rate) return r.live.Rate
  if (r['Comment Level']) return r['Comment Level']
  if (r['Age Group'] && r['Age Group'].Adult && r['Age Group'].Adult.Action) {
    return r['Age Group'].Adult.Action
  }
  return ''
}

// Tenants that have age-specific fields (adult_action, children_action)
const AGE_GROUP_TENANTS = new Set(['TikTok-Video-ContentClassification', 'PhotoPost'])

function getU18Action(entry) {
  if (AGE_GROUP_TENANTS.has(entry.tenant_name)) {
    return entry.children_action || ''
  }
  return ''
}

// Severity ranking: higher = more severe
function getActionSeverity(val) {
  if (!val) return 0
  const lower = val.toLowerCase()
  if (lower.includes('violation') || lower === 'ban' || lower === 'lv1') return 100
  if (lower === 'interrupt' || lower.includes('remove')) return 90
  if (lower.includes('suspend')) return 80
  if (lower.includes('not recommend') || lower.includes('not rec') || lower === 'lv2' || lower.includes('restrict')) return 60
  if (lower.includes('deboost') || lower.includes('pending')) return 50
  if (lower.includes('reset') || lower.includes('not for feed') || lower === 'not ff' || lower === 'lv3') return 40
  if (lower.includes('allow') || lower.includes('approve') || lower === 'general') return 20
  return 10
}

function getCellAction(entries, ageGroup = 'adult') {
  if (!entries || entries.length === 0) return ''
  const getAction = ageGroup === 'u18'
    ? (e) => getU18Action(e)
    : (e) => getPrimaryAction(e)
  if (entries.length === 1) return getAction(entries[0])
  let mostSevere = ''
  let highestSeverity = -1
  for (const e of entries) {
    const action = getAction(e)
    const sev = getActionSeverity(action)
    if (sev > highestSeverity) {
      highestSeverity = sev
      mostSevere = action
    }
  }
  return mostSevere
}

// Render a results object (flat or nested) for display in modal
function ResultSummary({ results }) {
  if (!results || Object.keys(results).length === 0) return <span className="action-badge empty">{'\u2014'}</span>

  return (
    <div className="results-summary">
      {Object.entries(results).map(([key, val]) => {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          return (
            <div key={key} className="result-group">
              <span className="result-key">{key}:</span>
              <div className="nested-group">
                {Object.entries(val).map(([nk, nv]) => (
                  <div key={nk}>
                    <span className="result-key">{nk}:</span>
                    <span className="result-val">
                      {nv && typeof nv === 'object' ? JSON.stringify(nv) : String(nv)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )
        }
        return (
          <div key={key} className="result-group">
            <span className="result-key">{key}:</span>
            <span className="result-val"> {String(val)}</span>
          </div>
        )
      })}
    </div>
  )
}

// --- Modal component ---

function Modal({ title, onClose, children }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button className="modal-close" onClick={onClose}>{'\u00D7'}</button>
        </div>
        <div className="modal-body">
          {children}
        </div>
      </div>
    </div>
  )
}

// --- Action Cell (single matrix cell) ---

function ActionCell({ entries, ageGroup = 'adult' }) {
  const action = getCellAction(entries, ageGroup)
  const count = entries ? entries.length : 0

  return (
    <div className="action-cell">
      <ActionBadge value={action} />
      {count > 1 && <span className="cell-count">{count}</span>}
    </div>
  )
}

// --- Tenant Detail Popup (View 1 drill-down) ---

function TenantDetailPopup({ groupLabel, entries, onClose }) {
  const byTenant = useMemo(() => {
    const map = new Map()
    for (const e of entries) {
      if (!map.has(e.tenant_name)) map.set(e.tenant_name, [])
      map.get(e.tenant_name).push(e)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [entries])

  return (
    <Modal title={groupLabel} onClose={onClose}>
      <table className="detail-table">
        <thead>
          <tr>
            <th>Tenant</th>
            <th>Title</th>
            <th>Code</th>
            <th>Action</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {byTenant.map(([tenant, tenantEntries]) =>
            tenantEntries.map((entry, idx) => (
              <tr key={`${entry.tenant_id}-${entry.policy_code}-${entry.region}-${idx}`}>
                {idx === 0 && (
                  <td className="tenant-col" rowSpan={tenantEntries.length}>{shortTenant(tenant)}</td>
                )}
                <td className="title-col" title={entry.policy_title}>{entry.policy_title}</td>
                <td className="code-col">{entry.policy_code}</td>
                <td><ActionBadge value={getPrimaryAction(entry)} /></td>
                <td><ResultSummary results={entry.results} /></td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </Modal>
  )
}

// --- Region Detail Popup (View 2 drill-down) ---

function RegionDetailPopup({ groupLabel, entries, onClose }) {
  const byRegion = useMemo(() => {
    const map = new Map()
    for (const e of entries) {
      if (!map.has(e.region)) map.set(e.region, [])
      map.get(e.region).push(e)
    }
    return [...map.entries()].sort((a, b) => {
      if (a[0] === 'General') return -1
      if (b[0] === 'General') return 1
      return a[0].localeCompare(b[0])
    })
  }, [entries])

  return (
    <Modal title={groupLabel} onClose={onClose}>
      <table className="detail-table">
        <thead>
          <tr>
            <th>Region</th>
            <th>Title</th>
            <th>Code</th>
            <th>Labels</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {byRegion.map(([region, regionEntries]) =>
            regionEntries.map((entry, idx) => (
              <tr key={`${entry.tenant_id}-${entry.policy_code}-${region}-${idx}`}>
                {idx === 0 && (
                  <td className="tenant-col" rowSpan={regionEntries.length}>{region}</td>
                )}
                <td className="title-col" title={entry.policy_title}>{entry.policy_title}</td>
                <td className="code-col">{entry.policy_code}</td>
                <td className="labels-col">
                  {(entry.labels || []).map((lbl, li) => (
                    <span key={li} className="label-chip">{lbl}</span>
                  ))}
                </td>
                <td><ActionBadge value={getPrimaryAction(entry)} /></td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </Modal>
  )
}

// --- Draggable header hook ---

function useDraggableColumns(initialOrder, pinnedCount = 0) {
  const [columnOrder, setColumnOrder] = useState(initialOrder)
  const dragIdx = useRef(null)
  const [dragOverIdx, setDragOverIdx] = useState(null)

  useEffect(() => {
    setColumnOrder(initialOrder)
  }, [initialOrder])

  const onDragStart = useCallback((idx, e) => {
    if (idx <= pinnedCount) { e.preventDefault(); return }
    dragIdx.current = idx
    e.dataTransfer.effectAllowed = 'move'
  }, [pinnedCount])

  const onDragOver = useCallback((idx, e) => {
    e.preventDefault()
    if (idx <= pinnedCount) return
    setDragOverIdx(idx)
  }, [pinnedCount])

  const onDragLeave = useCallback(() => {
    setDragOverIdx(null)
  }, [])

  const onDrop = useCallback((dropIdx) => {
    setDragOverIdx(null)
    const from = dragIdx.current
    if (from == null || from === dropIdx || dropIdx <= pinnedCount) return
    setColumnOrder(prev => {
      const next = [...prev]
      const [moved] = next.splice(from - 1, 1)
      next.splice(dropIdx - 1, 0, moved)
      return next
    })
    dragIdx.current = null
  }, [pinnedCount])

  return { columnOrder, dragOverIdx, draggingIdx: dragIdx, onDragStart, onDragOver, onDragLeave, onDrop }
}

// --- Category jump nav sidebar ---

function CategoryJumpNav({ categories, activeCategory, groupPrefix, heading, onReorder }) {
  const dragIdx = useRef(null)
  const [dragOverIdx, setDragOverIdx] = useState(null)

  const handleClick = useCallback((catName) => {
    const el = document.getElementById(`cat-${groupPrefix}-${catName}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [groupPrefix])

  const handleDragStart = useCallback((idx, e) => {
    dragIdx.current = idx
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', '')
  }, [])

  const handleDragOver = useCallback((idx, e) => {
    e.preventDefault()
    setDragOverIdx(idx)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverIdx(null)
  }, [])

  const handleDrop = useCallback((dropIdx) => {
    setDragOverIdx(null)
    const fromIdx = dragIdx.current
    if (fromIdx == null || fromIdx === dropIdx) return
    if (onReorder) {
      onReorder(categories[fromIdx].name, categories[dropIdx].name)
    }
    dragIdx.current = null
  }, [categories, onReorder])

  const handleDragEnd = useCallback(() => {
    setDragOverIdx(null)
    dragIdx.current = null
  }, [])

  return (
    <>
      {heading && <div className="jump-nav-heading">{heading}</div>}
      {categories.map((cat, idx) => (
        <button
          key={cat.name}
          className={`jump-nav-item${activeCategory === cat.name ? ' active' : ''}${dragOverIdx === idx ? ' jump-drag-over' : ''}`}
          onClick={() => handleClick(cat.name)}
          title={cat.name}
          draggable
          onDragStart={e => handleDragStart(idx, e)}
          onDragOver={e => handleDragOver(idx, e)}
          onDragLeave={handleDragLeave}
          onDrop={() => handleDrop(idx)}
          onDragEnd={handleDragEnd}
        >
          <span className="grip-icon" />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{cat.name}</span>
          <span className="jump-nav-count">{cat.rows.length}</span>
        </button>
      ))}
    </>
  )
}

// --- Build flat table rows with category label cells ---

function buildCategoryTableRows(categories, columnOrder, onRowClick, groupPrefix, opts = {}) {
  const { getEntries = (row, col) => row.byTenant.get(col), diffConfig, ageFilter = 'both', selectedTenantForRegion } = opts
  const showAdult = ageFilter === 'both' || ageFilter === 'adult'
  const showU18 = ageFilter === 'both' || ageFilter === 'u18'
  const showBoth = showAdult && showU18

  const regionTenantHasAge = selectedTenantForRegion ? AGE_GROUP_TENANTS.has(selectedTenantForRegion) : false

  const subColsPerCol = showBoth ? 2 : 1
  const totalSubCols = columnOrder.length * subColsPerCol + 2

  const colHasAge = (col) => {
    if (selectedTenantForRegion) return regionTenantHasAge
    return AGE_GROUP_TENANTS.has(col)
  }

  const rows = []
  for (const cat of categories) {
    rows.push(
      <tr key={`sep-${cat.name}`} className="category-separator-row" id={`cat-${groupPrefix}-${cat.name}`}>
        <td colSpan={totalSubCols}>
          {cat.name} ({cat.rows.length})
        </td>
      </tr>
    )
    cat.rows.forEach((row, rowIdx) => {
      const generalActionAdult = diffConfig ? getCellAction(diffConfig.getGeneral(row), 'adult') : null
      const generalActionU18 = diffConfig ? getCellAction(diffConfig.getGeneral(row), 'u18') : null
      rows.push(
        <tr key={row.label} onClick={() => onRowClick(row.label)}>
          {rowIdx === 0 && (
            <td className="category-label-cell" rowSpan={cat.rows.length}>
              <div className="category-label-inner">{cat.name}</div>
            </td>
          )}
          <td className="policy-name-cell" title={row.label}>{row.label}</td>
          {columnOrder.map((col, i) => {
            const colIdx = i + 1
            const entries = getEntries(row, col)
            const hasAge = colHasAge(col)

            const getDiffClass = (ageGroup) => {
              if (!diffConfig || col === diffConfig.baseCol) return ''
              const cellAction = getCellAction(entries, ageGroup)
              const generalAction = ageGroup === 'u18' ? generalActionU18 : generalActionAdult
              const isSame = (cellAction || '') === (generalAction || '')
              if (!isSame) return ' cell-diff'
              if (diffConfig.showDiffOnly) return ' cell-same-muted'
              return ''
            }

            if (showBoth) {
              const adultDiff = getDiffClass('adult')
              const u18Diff = getDiffClass('u18')
              return (
                <Fragment key={col}>
                  <td className={`sub-col-adult${colIdx % 2 === 0 ? ' col-even' : ' col-odd'}${adultDiff}`}>
                    {entries ? (
                      <ActionCell entries={entries} ageGroup="adult" />
                    ) : (
                      <span className="action-badge empty">{'\u2014'}</span>
                    )}
                  </td>
                  <td className={`sub-col-u18 sub-col-last${colIdx % 2 === 0 ? ' col-even' : ' col-odd'}${u18Diff}`}>
                    {entries && hasAge ? (
                      <ActionCell entries={entries} ageGroup="u18" />
                    ) : (
                      <span className="action-badge empty">{'\u2014'}</span>
                    )}
                  </td>
                </Fragment>
              )
            } else {
              const ageGroup = showAdult ? 'adult' : 'u18'
              const diffClass = getDiffClass(ageGroup)
              if (ageGroup === 'u18' && !hasAge) {
                return (
                  <td key={col} className={`${colIdx % 2 === 0 ? 'col-even' : 'col-odd'}${diffClass}`}>
                    <span className="action-badge empty">{'\u2014'}</span>
                  </td>
                )
              }
              return (
                <td key={col} className={`${colIdx % 2 === 0 ? 'col-even' : 'col-odd'}${diffClass}`}>
                  {entries ? (
                    <ActionCell entries={entries} ageGroup={ageGroup} />
                  ) : (
                    <span className="action-badge empty">{'\u2014'}</span>
                  )}
                </td>
              )
            }
          })}
        </tr>
      )
    })
  }
  return rows
}

// --- Tenant Matrix (View 1) with categories + anchor groups ---

function TenantMatrix({ rows, tenants, anchorTenant, onRowClick, columnOrder, dragProps, ageFilter = 'both' }) {
  const { dragOverIdx, onDragStart, onDragOver, onDragLeave, onDrop } = dragProps

  const { anchorCategoriesRaw, nonAnchorCategoriesRaw, anchorCount, nonAnchorCount, allCatNames } = useMemo(() => {
    const anchorRows = []
    const nonAnchorRows = []
    for (const row of rows) {
      if (row.byTenant.has(anchorTenant)) {
        anchorRows.push(row)
      } else {
        nonAnchorRows.push(row)
      }
    }
    const ac = groupByCategory(anchorRows)
    const nc = groupByCategory(nonAnchorRows)
    const names = new Set()
    for (const c of ac) names.add(c.name)
    for (const c of nc) names.add(c.name)
    return {
      anchorCategoriesRaw: ac,
      nonAnchorCategoriesRaw: nc,
      anchorCount: anchorRows.length,
      nonAnchorCount: nonAnchorRows.length,
      allCatNames: [...names],
    }
  }, [rows, anchorTenant])

  const defaultOrder = useMemo(() => {
    const mainFirst = MAIN_VERTICAL_ORDER.filter(c => allCatNames.includes(c))
    const rest = allCatNames.filter(c => !MAIN_VERTICAL_CATEGORIES.has(c)).sort()
    return [...mainFirst, ...rest]
  }, [allCatNames])

  const [categoryOrder, setCategoryOrder] = useState(null)

  const effectiveOrder = useMemo(() => {
    if (!categoryOrder) return defaultOrder
    const ordered = categoryOrder.filter(c => allCatNames.includes(c))
    for (const c of defaultOrder) {
      if (!ordered.includes(c)) ordered.push(c)
    }
    return ordered
  }, [categoryOrder, defaultOrder, allCatNames])

  const anchorCategories = useMemo(() => {
    return [...anchorCategoriesRaw].sort((a, b) => {
      const ai = effectiveOrder.indexOf(a.name)
      const bi = effectiveOrder.indexOf(b.name)
      return (ai === -1 ? 9999 : ai) - (bi === -1 ? 9999 : bi)
    })
  }, [anchorCategoriesRaw, effectiveOrder])

  const nonAnchorCategories = useMemo(() => {
    return [...nonAnchorCategoriesRaw].sort((a, b) => {
      const ai = effectiveOrder.indexOf(a.name)
      const bi = effectiveOrder.indexOf(b.name)
      return (ai === -1 ? 9999 : ai) - (bi === -1 ? 9999 : bi)
    })
  }, [nonAnchorCategoriesRaw, effectiveOrder])

  const handleCategoryReorder = useCallback((movedName, targetName) => {
    setCategoryOrder(prev => {
      const order = [...(prev || effectiveOrder)]
      const fromIdx = order.indexOf(movedName)
      const toIdx = order.indexOf(targetName)
      if (fromIdx === -1 || toIdx === -1) return prev
      order.splice(fromIdx, 1)
      order.splice(toIdx, 0, movedName)
      return order
    })
  }, [effectiveOrder])

  const [nonAnchorOpen, setNonAnchorOpen] = useState(false)
  const [activeCategory, setActiveCategory] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const observerRef = useRef(null)
  useEffect(() => {
    if (observerRef.current) observerRef.current.disconnect()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const catName = entry.target.getAttribute('data-category')
            if (catName) setActiveCategory(catName)
          }
        }
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 }
    )
    observerRef.current = observer
    document.querySelectorAll('.category-separator-row').forEach(el => {
      el.setAttribute('data-category', el.textContent.replace(/\s*\(\d+\)\s*$/, '').trim())
      observer.observe(el)
    })
    return () => observer.disconnect()
  }, [anchorCategories, nonAnchorCategories, nonAnchorOpen])

  const showBothAge = ageFilter === 'both'
  const showAdult = ageFilter === 'both' || ageFilter === 'adult'
  const showU18 = ageFilter === 'both' || ageFilter === 'u18'

  const renderHeader = () => (
    <thead>
      <tr>
        <th rowSpan={showBothAge ? 2 : 1}>{/* category label column */}</th>
        <th rowSpan={showBothAge ? 2 : 1}>Policy</th>
        {columnOrder.map((t, i) => {
          const colIdx = i + 1
          if (showBothAge) {
            return (
              <th
                key={t}
                colSpan={2}
                className={`${colIdx % 2 === 0 ? 'col-even' : 'col-odd'}${dragOverIdx === colIdx ? ' drag-over' : ''} sub-col-parent`}
                draggable
                onDragStart={e => onDragStart(colIdx, e)}
                onDragOver={e => onDragOver(colIdx, e)}
                onDragLeave={onDragLeave}
                onDrop={() => onDrop(colIdx)}
              >
                <span className="grip-icon" />{shortTenant(t)}
              </th>
            )
          }
          const suffix = showU18 ? ' U18' : ' 18+'
          return (
            <th
              key={t}
              className={`${colIdx % 2 === 0 ? 'col-even' : 'col-odd'}${dragOverIdx === colIdx ? ' drag-over' : ''}`}
              draggable
              onDragStart={e => onDragStart(colIdx, e)}
              onDragOver={e => onDragOver(colIdx, e)}
              onDragLeave={onDragLeave}
              onDrop={() => onDrop(colIdx)}
            >
              <span className="grip-icon" />{shortTenant(t)}{suffix}
            </th>
          )
        })}
      </tr>
      {showBothAge && (
        <tr className="sub-col-header-row">
          {columnOrder.map((t, i) => {
            const colIdx = i + 1
            return (
              <Fragment key={t}>
                <th className={`sub-col-label${colIdx % 2 === 0 ? ' col-even' : ' col-odd'}`}>18+</th>
                <th className={`sub-col-label sub-col-last${colIdx % 2 === 0 ? ' col-even' : ' col-odd'}`}>U18</th>
              </Fragment>
            )
          })}
        </tr>
      )}
    </thead>
  )

  if (rows.length === 0) {
    return (
      <div className="content-area">
        <div className="matrix-wrapper"><div className="empty-state">No policies match the current filters.</div></div>
      </div>
    )
  }

  const getEntries = (row, col) => row.byTenant.get(col)
  const anchorTableRows = buildCategoryTableRows(anchorCategories, columnOrder, onRowClick, 'anchor', { getEntries, ageFilter })
  const nonAnchorTableRows = nonAnchorOpen
    ? buildCategoryTableRows(nonAnchorCategories, columnOrder, onRowClick, 'other', { getEntries, ageFilter })
    : []

  return (
    <div className="content-area">
      <nav className={`category-jump-nav${sidebarOpen ? ' sidebar-open' : ''}`}>
        <CategoryJumpNav categories={anchorCategories} activeCategory={activeCategory} groupPrefix="anchor" heading={`In ${shortTenant(anchorTenant)}`} onReorder={handleCategoryReorder} />
        {nonAnchorOpen && nonAnchorCategories.length > 0 && (
          <>
            <div className="jump-nav-separator" />
            <CategoryJumpNav categories={nonAnchorCategories} activeCategory={activeCategory} groupPrefix="other" heading="Other" onReorder={handleCategoryReorder} />
          </>
        )}
      </nav>
      <button className="sidebar-toggle-btn" onClick={() => setSidebarOpen(p => !p)} aria-label="Toggle sidebar">
        {sidebarOpen ? '\u2715' : '\u2630'}
      </button>

      <div className="matrix-wrapper">
        <div className="anchor-group">
          <div className="anchor-group-header">
            <span className="anchor-group-title">In {shortTenant(anchorTenant)}</span>
            <span className="anchor-group-count">{anchorCount} policies</span>
          </div>
          <table className="matrix-table has-categories">
            {renderHeader()}
            <tbody>{anchorTableRows}</tbody>
          </table>
        </div>

        {nonAnchorCount > 0 && (
          <div className="anchor-group">
            <div className="anchor-group-header" onClick={() => setNonAnchorOpen(p => !p)}>
              <span className={`category-arrow${nonAnchorOpen ? ' open' : ''}`}>{'\u25B6'}</span>
              <span className="anchor-group-title">Not in {shortTenant(anchorTenant)}</span>
              <span className="anchor-group-count">{nonAnchorCount} policies</span>
            </div>
            {nonAnchorOpen && (
              <table className="matrix-table has-categories">
                {renderHeader()}
                <tbody>{nonAnchorTableRows}</tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Helper: group rows by primary category
function groupByCategory(rows) {
  const map = new Map()
  for (const row of rows) {
    const cats = {}
    for (const e of row.entries) {
      const c = e.cat0 || 'Uncategorized'
      cats[c] = (cats[c] || 0) + 1
    }
    const cat = Object.entries(cats).sort((a, b) => b[1] - a[1])[0][0]
    row.primaryCategory = cat
    if (!map.has(cat)) map.set(cat, [])
    map.get(cat).push(row)
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, catRows]) => ({
      name,
      rows: catRows.sort((a, b) => a.label.localeCompare(b.label))
    }))
}

// --- Region Matrix (View 2) ---

function RegionMatrix({ rows, regions, selectedTenant, onRowClick, showDiffOnly, ageFilter = 'both' }) {
  const defaultRegionOrder = useMemo(() => {
    const hasGeneral = regions.includes('General')
    const rest = regions.filter(r => r !== 'General').sort()
    return hasGeneral ? ['General', ...rest] : rest
  }, [regions])

  const { columnOrder, dragOverIdx, onDragStart, onDragOver, onDragLeave, onDrop } = useDraggableColumns(defaultRegionOrder, 1)

  const categoriesRaw = useMemo(() => groupByCategory(rows), [rows])
  const allCatNames = useMemo(() => categoriesRaw.map(c => c.name), [categoriesRaw])

  const defaultCatOrder = useMemo(() => {
    const mainFirst = MAIN_VERTICAL_ORDER.filter(c => allCatNames.includes(c))
    const rest = allCatNames.filter(c => !MAIN_VERTICAL_CATEGORIES.has(c)).sort()
    return [...mainFirst, ...rest]
  }, [allCatNames])

  const [categoryOrder, setCategoryOrder] = useState(null)
  const effectiveCatOrder = useMemo(() => {
    if (!categoryOrder) return defaultCatOrder
    const ordered = categoryOrder.filter(c => allCatNames.includes(c))
    for (const c of defaultCatOrder) {
      if (!ordered.includes(c)) ordered.push(c)
    }
    return ordered
  }, [categoryOrder, defaultCatOrder, allCatNames])

  const categories = useMemo(() => {
    return [...categoriesRaw].sort((a, b) => {
      const ai = effectiveCatOrder.indexOf(a.name)
      const bi = effectiveCatOrder.indexOf(b.name)
      return (ai === -1 ? 9999 : ai) - (bi === -1 ? 9999 : bi)
    })
  }, [categoriesRaw, effectiveCatOrder])

  const handleCategoryReorder = useCallback((movedName, targetName) => {
    setCategoryOrder(prev => {
      const order = [...(prev || effectiveCatOrder)]
      const fromIdx = order.indexOf(movedName)
      const toIdx = order.indexOf(targetName)
      if (fromIdx === -1 || toIdx === -1) return prev
      order.splice(fromIdx, 1)
      order.splice(toIdx, 0, movedName)
      return order
    })
  }, [effectiveCatOrder])

  const [activeCategory, setActiveCategory] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const observerRef = useRef(null)
  useEffect(() => {
    if (observerRef.current) observerRef.current.disconnect()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const catName = entry.target.getAttribute('data-category')
            if (catName) setActiveCategory(catName)
          }
        }
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 }
    )
    observerRef.current = observer
    document.querySelectorAll('.category-separator-row').forEach(el => {
      el.setAttribute('data-category', el.textContent.replace(/\s*\(\d+\)\s*$/, '').trim())
      observer.observe(el)
    })
    return () => observer.disconnect()
  }, [categories])

  const regionShowBoth = ageFilter === 'both'
  const regionShowU18 = ageFilter === 'u18'

  if (rows.length === 0) {
    return (
      <div className="content-area">
        <div className="matrix-wrapper"><div className="empty-state">No policies match the current filters.</div></div>
      </div>
    )
  }

  const tableRows = buildCategoryTableRows(categories, columnOrder, onRowClick, 'region', {
    getEntries: (row, col) => row.byRegion.get(col) || (col !== 'General' ? row.byRegion.get('General') : undefined),
    diffConfig: {
      getGeneral: (row) => row.byRegion.get('General'),
      baseCol: 'General',
      showDiffOnly,
    },
    ageFilter,
    selectedTenantForRegion: selectedTenant,
  })

  return (
    <div className="content-area">
      <nav className={`category-jump-nav${sidebarOpen ? ' sidebar-open' : ''}`}>
        <CategoryJumpNav
          categories={categories}
          activeCategory={activeCategory}
          groupPrefix="region"
          heading={shortTenant(selectedTenant)}
          onReorder={handleCategoryReorder}
        />
      </nav>
      <button className="sidebar-toggle-btn" onClick={() => setSidebarOpen(p => !p)} aria-label="Toggle sidebar">
        {sidebarOpen ? '\u2715' : '\u2630'}
      </button>
      <div className="matrix-wrapper">
        <table className="matrix-table has-categories">
          <thead>
            <tr>
              <th rowSpan={regionShowBoth ? 2 : 1}>{/* category label column */}</th>
              <th rowSpan={regionShowBoth ? 2 : 1}>Policy</th>
              {columnOrder.map((r, i) => {
                const colIdx = i + 1
                const isPinned = colIdx === 1
                if (regionShowBoth) {
                  return (
                    <th
                      key={r}
                      colSpan={2}
                      className={`${colIdx % 2 === 0 ? 'col-even' : 'col-odd'}${dragOverIdx === colIdx ? ' drag-over' : ''}${isPinned ? ' pinned-col' : ''} sub-col-parent`}
                      draggable={!isPinned}
                      onDragStart={e => onDragStart(colIdx, e)}
                      onDragOver={e => onDragOver(colIdx, e)}
                      onDragLeave={onDragLeave}
                      onDrop={() => onDrop(colIdx)}
                    >
                      {!isPinned && <span className="grip-icon" />}{r}
                    </th>
                  )
                }
                const suffix = regionShowU18 ? ' U18' : ' 18+'
                return (
                  <th
                    key={r}
                    className={`${colIdx % 2 === 0 ? 'col-even' : 'col-odd'}${dragOverIdx === colIdx ? ' drag-over' : ''}${isPinned ? ' pinned-col' : ''}`}
                    draggable={!isPinned}
                    onDragStart={e => onDragStart(colIdx, e)}
                    onDragOver={e => onDragOver(colIdx, e)}
                    onDragLeave={onDragLeave}
                    onDrop={() => onDrop(colIdx)}
                  >
                    {!isPinned && <span className="grip-icon" />}{r}{suffix}
                  </th>
                )
              })}
            </tr>
            {regionShowBoth && (
              <tr className="sub-col-header-row">
                {columnOrder.map((r, i) => {
                  const colIdx = i + 1
                  return (
                    <Fragment key={r}>
                      <th className={`sub-col-label${colIdx % 2 === 0 ? ' col-even' : ' col-odd'}`}>18+</th>
                      <th className={`sub-col-label sub-col-last${colIdx % 2 === 0 ? ' col-even' : ' col-odd'}`}>U18</th>
                    </Fragment>
                  )
                })}
              </tr>
            )}
          </thead>
          <tbody>{tableRows}</tbody>
        </table>
      </div>
    </div>
  )
}

// --- Cookie prompt screen ---

function CookiePrompt({ error, onSubmit, savedCookie }) {
  const [input, setInput] = useState(savedCookie || '')

  const handleSubmit = (e) => {
    e.preventDefault()
    if (input.trim()) onSubmit(input)
  }

  return (
    <div className="loading-overlay">
      <div className="auth-card">
        <div className="auth-title">Policy Viewer (Live)</div>
        <div className="auth-description">
          This app fetches live data from PMS. To authenticate, paste your session cookie from
          <strong> pms-va.tiktok-row.net</strong>.
        </div>
        <div className="auth-steps">
          <div className="auth-step">1. Open <strong>pms-va.tiktok-row.net</strong> in your browser and log in</div>
          <div className="auth-step">2. Open DevTools (F12) &rarr; Application &rarr; Cookies</div>
          <div className="auth-step">3. Copy all cookies (or just the session/auth cookies) as a single string</div>
          <div className="auth-step">
            <em>Tip: In Chrome DevTools Console, type <code>document.cookie</code> and copy the result</em>
          </div>
        </div>
        {error && <div className="auth-error">{error}</div>}
        <form onSubmit={handleSubmit} className="auth-form">
          <textarea
            className="auth-input"
            placeholder="Paste cookie string here... (e.g. session_id=abc123; csrftoken=xyz)"
            value={input}
            onChange={e => setInput(e.target.value)}
            rows={3}
          />
          <button type="submit" className="auth-submit" disabled={!input.trim()}>
            Connect
          </button>
        </form>
      </div>
    </div>
  )
}

// --- App ---

export default function App() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadPhase, setLoadPhase] = useState('')  // 'lists' | 'details' | ''
  const [loadProgress, setLoadProgress] = useState({ done: 0, total: 0 })
  const [lastFetched, setLastFetched] = useState(null)
  const [error, setError] = useState(null)
  const [activeTab, setActiveTab] = useState('tenant')
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [multiTenantOnly, setMultiTenantOnly] = useState(false)
  const [mainVerticalsOnly, setMainVerticalsOnly] = useState(false)
  const [selectedTenant, setSelectedTenant] = useState('TikTok-Video-ContentClassification')
  const [anchorTenant, setAnchorTenant] = useState('TikTok-Video-ContentClassification')
  const [modalData, setModalData] = useState(null)
  const [showDiffOnly, setShowDiffOnly] = useState(false)
  const [ageFilter, setAgeFilter] = useState('both')
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
  const [cookie, setCookie] = useState(getSavedCookie)
  const [needsAuth, setNeedsAuth] = useState(!getSavedCookie())

  const fetchAbortRef = useRef(null)

  const loadData = useCallback(async (cookieOverride) => {
    const activeCookie = cookieOverride !== undefined ? cookieOverride : cookie
    if (!activeCookie) {
      setNeedsAuth(true)
      setLoading(false)
      return
    }

    // Abort any previous fetch
    if (fetchAbortRef.current) fetchAbortRef.current.aborted = true
    const thisRun = { aborted: false }
    fetchAbortRef.current = thisRun

    setNeedsAuth(false)
    setLoading(true)
    setError(null)
    setLoadPhase('lists')
    setLoadProgress({ done: 0, total: TENANT_IDS.length })

    try {
      // Phase 1: Fetch list for all tenants in parallel
      const listResults = await batchFetch(
        TENANT_IDS,
        async (tenantId) => {
          const items = await fetchTenantList(tenantId, activeCookie)
          return { tenantId, items }
        },
        11,  // All 11 in parallel
        (done, total) => {
          if (!thisRun.aborted) setLoadProgress({ done, total })
        }
      )

      if (thisRun.aborted) return

      // Build a flat list of (tenantId, tenantName, listItem) to fetch details for
      const detailTasks = []

      for (const result of listResults) {
        if (!result) continue
        const { tenantId, items } = result
        const tenantName = TENANT_MAP[tenantId]
        for (const item of items) {
          if (!item.regionPolicyID) continue
          detailTasks.push({
            tenantId,
            tenantName,
            listItem: item,
            regionPolicyID: item.regionPolicyID,
          })
        }
      }

      if (thisRun.aborted) return

      // Phase 2: Fetch details with concurrency limit
      setLoadPhase('details')
      setLoadProgress({ done: 0, total: detailTasks.length })

      // Deduplicate detail fetches by regionPolicyID (cache detail results)
      const detailFetchCache = new Map()

      const allEntries = []
      let entryId = 0

      const detailResults = await batchFetch(
        detailTasks,
        async (task) => {
          let detailData
          const cacheKey = `${task.tenantId}:${task.regionPolicyID}`
          if (detailFetchCache.has(cacheKey)) {
            detailData = detailFetchCache.get(cacheKey)
          } else {
            detailData = await fetchPolicyDetail(task.regionPolicyID, task.tenantId, activeCookie)
            detailFetchCache.set(cacheKey, detailData)
          }
          const entries = transformDetailToEntries(detailData, task.tenantId, task.tenantName, task.listItem)
          return entries
        },
        20,  // 20 concurrent requests
        (done, total) => {
          if (!thisRun.aborted) setLoadProgress({ done, total })
        }
      )

      if (thisRun.aborted) return

      // Flatten all entries and assign IDs
      for (const entries of detailResults) {
        if (!entries) continue
        for (const entry of entries) {
          entry.id = entryId++
          allEntries.push(entry)
        }
      }

      setData(allEntries)
      setLastFetched(new Date())
      setLoading(false)
      setLoadPhase('')
    } catch (err) {
      if (!thisRun.aborted) {
        console.error('Failed to load data:', err)
        if (err.message === 'AUTH_REQUIRED') {
          setNeedsAuth(true)
          setLoading(false)
          setLoadPhase('')
          setError('Session expired or invalid. Please update your cookie.')
        } else {
          setError(err.message)
          setLoading(false)
          setLoadPhase('')
        }
      }
    }
  }, [cookie])

  const handleCookieSubmit = useCallback((newCookie) => {
    const trimmed = newCookie.trim()
    setCookie(trimmed)
    saveCookie(trimmed)
    setNeedsAuth(false)
    loadData(trimmed)
  }, [loadData])

  useEffect(() => {
    if (cookie) loadData()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Fuzzy-group all data once
  const fuzzyGroups = useMemo(() => {
    if (!data) return null
    return buildFuzzyGroups(data)
  }, [data])

  // All unique tenants & categories
  const allTenants = useMemo(() => {
    if (!data) return []
    return [...new Set(data.map(e => e.tenant_name))].sort()
  }, [data])

  const allCategories = useMemo(() => {
    if (!data) return []
    return [...new Set(data.filter(e => e.cat0).map(e => e.cat0))].sort()
  }, [data])

  const allRegions = useMemo(() => {
    if (!data) return []
    return [...new Set(data.map(e => e.region))].sort()
  }, [data])

  const tenantRegions = useMemo(() => {
    if (!data || !selectedTenant) return []
    const regions = new Set()
    for (const e of data) {
      if (e.tenant_name === selectedTenant) regions.add(e.region)
    }
    return [...regions]
  }, [data, selectedTenant])

  const defaultTenantColumnOrder = useMemo(() => {
    if (!allTenants.length) return []
    const ordered = []
    if (allTenants.includes(anchorTenant)) ordered.push(anchorTenant)
    for (const t of DEFAULT_TENANT_ORDER) {
      if (t !== anchorTenant && allTenants.includes(t)) ordered.push(t)
    }
    for (const t of allTenants) {
      if (!ordered.includes(t)) ordered.push(t)
    }
    return ordered
  }, [allTenants, anchorTenant])

  const dragProps = useDraggableColumns(defaultTenantColumnOrder)

  // === VIEW 1: Tenant View Data ===
  const tenantViewData = useMemo(() => {
    if (!fuzzyGroups) return []
    const rows = []
    for (const [label, entries] of fuzzyGroups) {
      const generalEntries = entries.filter(e => e.region === 'General')
      if (generalEntries.length === 0) continue

      const byTenant = new Map()
      for (const e of generalEntries) {
        if (!byTenant.has(e.tenant_name)) byTenant.set(e.tenant_name, [])
        byTenant.get(e.tenant_name).push(e)
      }
      rows.push({ label, entries: generalEntries, byTenant })
    }
    return rows
  }, [fuzzyGroups])

  // Filtered tenant rows
  const filteredTenantRows = useMemo(() => {
    let rows = tenantViewData
    if (multiTenantOnly) {
      rows = rows.filter(r => r.byTenant.size >= 2)
    }
    if (mainVerticalsOnly) {
      rows = rows.filter(r => r.entries.some(e => MAIN_VERTICAL_CATEGORIES.has(e.cat0)))
    }
    if (categoryFilter) {
      rows = rows.filter(r => r.entries.some(e => e.cat0 === categoryFilter))
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      rows = rows.filter(r => {
        if (r.label.toLowerCase().includes(q)) return true
        if (r.entries.some(e => e.policy_title.toLowerCase().includes(q))) return true
        if (r.entries.some(e => (e.cat0 || '').toLowerCase().includes(q) || (e.cat1 || '').toLowerCase().includes(q))) return true
        if (r.entries.some(e => e.policy_code.toLowerCase().includes(q))) return true
        return false
      })
    }
    return rows.sort((a, b) => {
      const aHas = a.byTenant.has(anchorTenant) ? 0 : 1
      const bHas = b.byTenant.has(anchorTenant) ? 0 : 1
      if (aHas !== bHas) return aHas - bHas
      return a.label.localeCompare(b.label)
    })
  }, [tenantViewData, multiTenantOnly, mainVerticalsOnly, categoryFilter, search, anchorTenant])

  // === VIEW 2: Region View Data ===
  const regionViewData = useMemo(() => {
    if (!fuzzyGroups || !selectedTenant) return []
    const rows = []
    for (const [label, entries] of fuzzyGroups) {
      const tenantEntries = entries.filter(e => e.tenant_name === selectedTenant)
      if (tenantEntries.length === 0) continue

      const byRegion = new Map()
      for (const e of tenantEntries) {
        if (!byRegion.has(e.region)) byRegion.set(e.region, [])
        byRegion.get(e.region).push(e)
      }
      if (!byRegion.has('General')) continue
      rows.push({ label, entries: tenantEntries, byRegion })
    }
    return rows
  }, [fuzzyGroups, selectedTenant])

  const filteredRegionRows = useMemo(() => {
    let rows = regionViewData
    if (categoryFilter) {
      rows = rows.filter(r => r.entries.some(e => e.cat0 === categoryFilter))
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      rows = rows.filter(r => {
        if (r.label.toLowerCase().includes(q)) return true
        if (r.entries.some(e => e.policy_title.toLowerCase().includes(q))) return true
        if (r.entries.some(e => (e.cat0 || '').toLowerCase().includes(q) || (e.cat1 || '').toLowerCase().includes(q))) return true
        if (r.entries.some(e => e.policy_code.toLowerCase().includes(q))) return true
        return false
      })
    }
    return rows.sort((a, b) => a.label.localeCompare(b.label))
  }, [regionViewData, categoryFilter, search])

  // --- Row click handlers ---
  const handleTenantRowClick = useCallback((label) => {
    const row = tenantViewData.find(r => r.label === label)
    if (row) {
      setModalData({ type: 'tenant', groupLabel: label, entries: row.entries })
    }
  }, [tenantViewData])

  const handleRegionRowClick = useCallback((label) => {
    const row = regionViewData.find(r => r.label === label)
    if (row) {
      setModalData({ type: 'region', groupLabel: label, entries: row.entries })
    }
  }, [regionViewData])

  const closeModal = useCallback(() => setModalData(null), [])

  // --- Auth screen ---
  if (needsAuth || (!loading && !data && !error)) {
    return <CookiePrompt error={error} onSubmit={handleCookieSubmit} savedCookie={cookie} />
  }

  // --- Loading state ---
  if (loading) {
    const pct = loadProgress.total > 0
      ? Math.round((loadProgress.done / loadProgress.total) * 100)
      : 0
    const phaseLabel = loadPhase === 'lists'
      ? `Loading policies... ${loadProgress.done}/${loadProgress.total} tenants`
      : loadPhase === 'details'
        ? `Loading details... ${loadProgress.done}/${loadProgress.total} policies`
        : 'Initializing...'

    return (
      <div className="loading-overlay">
        <div className="spinner" />
        <div className="loading-text">{phaseLabel}</div>
        <div className="progress-bar-container">
          <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="loading-text">{pct}%</div>
      </div>
    )
  }

  if (error && !data) {
    return <CookiePrompt error={error} onSubmit={handleCookieSubmit} savedCookie={cookie} />
  }

  const currentRows = activeTab === 'tenant' ? filteredTenantRows : filteredRegionRows

  return (
    <div className="app">
      {/* Toolbar */}
      <div className="toolbar">
        <div className="toolbar-primary">
          <span className="toolbar-title">Policy Viewer (Live)</span>

          <div className="tab-switcher">
            <button
              className={`tab-btn${activeTab === 'tenant' ? ' active' : ''}`}
              onClick={() => setActiveTab('tenant')}
            >
              Features
            </button>
            <button
              className={`tab-btn${activeTab === 'region' ? ' active' : ''}`}
              onClick={() => setActiveTab('region')}
            >
              Regions
            </button>
          </div>

          <input
            className="search-input"
            type="text"
            placeholder="Search policies..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />

          <button
            className="hamburger-btn"
            onClick={() => setMobileFiltersOpen(p => !p)}
            aria-label="Toggle filters"
          >
            {mobileFiltersOpen ? '\u2715' : '\u2630'}
          </button>

          <button className="refresh-btn" onClick={loadData} title="Refresh data from API">
            {'\u21BB'}
          </button>

          {lastFetched && (
            <span className="last-fetched" title={lastFetched.toLocaleString()}>
              {lastFetched.toLocaleTimeString()}
            </span>
          )}

          <span className="result-count">
            {currentRows.length} policies
          </span>
        </div>

        <div className={`toolbar-filters${mobileFiltersOpen ? ' open' : ''}`}>
          <select
            className="filter-select"
            value={categoryFilter}
            onChange={e => setCategoryFilter(e.target.value)}
          >
            <option value="">All Categories</option>
            {allCategories.filter(c => MAIN_VERTICAL_CATEGORIES.has(c)).map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
            <option disabled>{'\u2500'.repeat(20)}</option>
            {allCategories.filter(c => !MAIN_VERTICAL_CATEGORIES.has(c)).map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          <div className="tab-switcher age-filter">
            <button className={`tab-btn${ageFilter === 'both' ? ' active' : ''}`} onClick={() => setAgeFilter('both')}>Both</button>
            <button className={`tab-btn${ageFilter === 'adult' ? ' active' : ''}`} onClick={() => setAgeFilter('adult')}>18+</button>
            <button className={`tab-btn${ageFilter === 'u18' ? ' active' : ''}`} onClick={() => setAgeFilter('u18')}>U18</button>
          </div>

          {activeTab === 'tenant' && (
            <>
              <div className="filter-field">
                <span className="filter-field-label">Anchor Tenant</span>
                <div className="filter-field-tooltip">
                  Basis for comparison. Appears in the first column; policies are grouped by presence in this tenant.
                </div>
                <select
                  className="filter-select"
                  value={anchorTenant}
                  onChange={e => setAnchorTenant(e.target.value)}
                >
                  {allTenants.map(t => <option key={t} value={t}>{shortTenant(t)}</option>)}
                </select>
              </div>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={multiTenantOnly}
                  onChange={e => setMultiTenantOnly(e.target.checked)}
                />
                Multi-tenant only
              </label>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={mainVerticalsOnly}
                  onChange={e => setMainVerticalsOnly(e.target.checked)}
                />
                Main Verticals Only
              </label>
            </>
          )}

          {activeTab === 'region' && (
            <>
              <div className="filter-field">
                <span className="filter-field-label">Tenant</span>
                <select
                  className="filter-select"
                  value={selectedTenant}
                  onChange={e => setSelectedTenant(e.target.value)}
                >
                  {allTenants.map(t => <option key={t} value={t}>{shortTenant(t)}</option>)}
                </select>
              </div>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={showDiffOnly}
                  onChange={e => setShowDiffOnly(e.target.checked)}
                />
                Show Diff Only
              </label>
            </>
          )}
        </div>
      </div>

      {/* Matrix */}
      {activeTab === 'tenant' ? (
        <TenantMatrix
          rows={filteredTenantRows}
          tenants={dragProps.columnOrder}
          anchorTenant={anchorTenant}
          onRowClick={handleTenantRowClick}
          columnOrder={dragProps.columnOrder}
          dragProps={dragProps}
          ageFilter={ageFilter}
        />
      ) : (
        <RegionMatrix
          rows={filteredRegionRows}
          regions={tenantRegions}
          selectedTenant={selectedTenant}
          onRowClick={handleRegionRowClick}
          showDiffOnly={showDiffOnly}
          ageFilter={ageFilter}
        />
      )}

      {/* Modal */}
      {modalData && modalData.type === 'tenant' && (
        <TenantDetailPopup
          groupLabel={modalData.groupLabel}
          entries={modalData.entries}
          onClose={closeModal}
        />
      )}
      {modalData && modalData.type === 'region' && (
        <RegionDetailPopup
          groupLabel={modalData.groupLabel}
          entries={modalData.entries}
          onClose={closeModal}
        />
      )}
    </div>
  )
}
