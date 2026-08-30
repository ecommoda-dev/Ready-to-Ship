// =============================================================
//  ready-to-ship-worker
//  قائمة أوردرات القاهرة — جاهزة للشحن
//  Account : ecommoda-dev (762c353004e8472b20261fba273bfe8d)
//  CORS    : wildcard (read-only dashboard)
//  D1      : none (no login, no audit log)
// =============================================================

// ── CORS ──────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
function getCORS() { return CORS_HEADERS; }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ── Shopify helpers ───────────────────────────────────────────
async function getAccessToken(env) {
  const r = await fetch(
    `https://${env.SHOP_DOMAIN}/admin/oauth/access_token`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        client_id:     env.CLIENT_ID,
        client_secret: env.CLIENT_SECRET,
        grant_type:    'client_credentials',
      }),
    }
  );
  if (!r.ok) throw new Error(`OAuth failed: ${r.status}`);
  const d = await r.json();
  if (!d.access_token) throw new Error('OAuth: no access_token in response');
  return d.access_token;
}

async function shopifyGQL(env, token, query, variables = {}) {
  const r = await fetch(
    `https://${env.SHOP_DOMAIN}/admin/api/2026-01/graphql.json`,
    {
      method:  'POST',
      headers: {
        'Content-Type':           'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  return r.json();
}

// ── GraphQL Queries ───────────────────────────────────────────

// Full order fields for the main list
const ORDER_LIST_QUERY = `
  query GetReadyOrders($cursor: String, $filter: String!) {
    orders(first: 250, after: $cursor, query: $filter) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id
        name
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        shippingAddress { firstName lastName city address1 phone }
        manual_status:         metafield(namespace: "custom", key: "manual_status")         { value }
        status_2_r_e:          metafield(namespace: "custom", key: "status_2_r_e")          { value }
        printing_time_s1:      metafield(namespace: "custom", key: "printing_time_s1")      { value }
        printing_time_s2:      metafield(namespace: "custom", key: "printing_time_s2")      { value }
        s1_packed_by:          metafield(namespace: "custom", key: "s1_packed_by")          { value }
        s1_packing_date_time:  metafield(namespace: "custom", key: "s1_packing_date_time")  { value }
        s2_packed_by:          metafield(namespace: "custom", key: "s2_packed_by")          { value }
        s2_packing_date_time:  metafield(namespace: "custom", key: "s2_packing_date_time")  { value }
      }}
    }
  }
`;

// Minimal fields for lookup of unexpected scanned orders
// Used for both name-based and ID-based lookups
const ORDER_LOOKUP_QUERY = `
  query LookupOrder($q: String!) {
    orders(first: 1, query: $q) {
      edges { node {
        id
        name
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        shippingAddress { city }
        manual_status: metafield(namespace: "custom", key: "manual_status") { value }
        status_2_r_e:  metafield(namespace: "custom", key: "status_2_r_e")  { value }
        tags
      }}
    }
  }
`;

// ── Pagination helper ─────────────────────────────────────────
async function paginateOrders(env, token, filter) {
  const all = [];
  let cursor = null, hasNext = true;

  while (hasNext) {
    const data = await shopifyGQL(env, token, ORDER_LIST_QUERY, { cursor, filter });
    const conn = data?.data?.orders;
    if (!conn) {
      const errMsg = data?.errors?.[0]?.message || JSON.stringify(data?.errors);
      throw new Error(`GraphQL error: ${errMsg}`);
    }
    for (const edge of conn.edges) all.push(edge.node);
    hasNext = conn.pageInfo.hasNextPage;
    cursor  = conn.pageInfo.endCursor;
  }

  return all;
}

// ── Order mapper ──────────────────────────────────────────────
function mapOrder(node) {
  const s2Ready = node.status_2_r_e?.value === 'Ready';
  const isS2    = s2Ready;

  const printingTime    = isS2
    ? (node.printing_time_s2?.value      || null)
    : (node.printing_time_s1?.value      || null);
  const packedBy        = isS2
    ? (node.s2_packed_by?.value          || null)
    : (node.s1_packed_by?.value          || null);
  const packingDateTime = isS2
    ? (node.s2_packing_date_time?.value  || null)
    : (node.s1_packing_date_time?.value  || null);

  return {
    id:             node.id,
    numericId:      node.id.split('/').pop(),
    name:           node.name,
    createdAt:      node.createdAt,
    financial:      node.displayFinancialStatus,
    fulfillment:    node.displayFulfillmentStatus,
    address:        node.shippingAddress || null,
    orderType:      isS2 ? 'S2' : 'S1',
    s1Status:       node.manual_status?.value  || '',
    s2Status:       node.status_2_r_e?.value   || '',
    printingTime,
    packedBy,
    packingDateTime,
  };
}

// ── Lookup one order — by name OR by numeric ID ───────────────
// queryStr examples:
//   name-based  → 'name:#43458'
//   id-based    → 'id:6959895839042'
async function lookupOneOrder(env, token, queryStr) {
  const data = await shopifyGQL(env, token, ORDER_LOOKUP_QUERY, { q: queryStr });
  const edge = data?.data?.orders?.edges?.[0];
  if (!edge) return null;
  const n = edge.node;
  return {
    found:       true,
    id:          n.id,
    numericId:   n.id.split('/').pop(),
    name:        n.name,
    createdAt:   n.createdAt,
    financial:   n.displayFinancialStatus  || '—',
    fulfillment: n.displayFulfillmentStatus || '—',
    city:        n.shippingAddress?.city    || '—',
    s1Status:    n.manual_status?.value     || '—',
    s2Status:    n.status_2_r_e?.value      || '—',
    tags:        (n.tags || []).join(', '),
  };
}

// ── Main Export ───────────────────────────────────────────────
export default {
  async fetch(request, env) {

    // 1. CORS preflight — always first
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: getCORS() });

    // 2. WORKER_SECRET check — always second
    const auth = request.headers.get('Authorization') || '';
    if (auth !== `Bearer ${env.WORKER_SECRET}`)
      return json({ error: 'Unauthorized' }, 401);

    const url    = new URL(request.url.replace(/\/$/, ''));
    const action = url.searchParams.get('action');

    try {

      // ── GET: get_ready_orders ─────────────────────────────
      if (action === 'get_ready_orders') {
        const token = await getAccessToken(env);

        const [s1Nodes, s2Nodes] = await Promise.all([
          paginateOrders(env, token, 'metafields.custom.manual_status:Ready'),
          paginateOrders(env, token, 'metafields.custom.status_2_r_e:Ready'),
        ]);

        const seen     = new Set();
        const combined = [];
        for (const node of [...s1Nodes, ...s2Nodes]) {
          if (!seen.has(node.id)) {
            seen.add(node.id);
            combined.push(node);
          }
        }

        const orders = combined
          .map(mapOrder)
          .filter(o => o.printingTime && o.packedBy)
          .sort((a, b) => new Date(b.printingTime) - new Date(a.printingTime));

        return json({
          orders,
          fetchedAt: new Date().toISOString(),
          counts: {
            total: orders.length,
            s1:    orders.filter(o => o.orderType === 'S1').length,
            s2:    orders.filter(o => o.orderType === 'S2').length,
          },
        });
      }

      // ── POST: lookup_orders ───────────────────────────────
      // Receives:
      //   { names: ['#43458', '#6966085583170'], numericIds: ['6959895839042'] }
      //
      // Strategy per item:
      //   - If name looks like a real order name (short number after #) → query by name
      //   - If name has a long numeric suffix (>10 digits) → it's actually an Order ID
      //     stored as display name → query by id: instead
      //   - numericIds array → always query by id:
      //
      // All queries run in parallel batches of 10.
      if (action === 'lookup_orders' && request.method === 'POST') {
        const body       = await request.json().catch(() => ({}));
        const names      = Array.isArray(body.names)      ? body.names      : [];
        const numericIds = Array.isArray(body.numericIds) ? body.numericIds : [];

        const token = await getAccessToken(env);

        // Build a unified work list: [{ key, queryStr }]
        // key = the original value sent by HTML (for result mapping)
        const workList = [];

        for (const rawName of names) {
          // Extract the digits from the name (#43458 → '43458', #6966085583170 → '6966085583170')
          const digits = rawName.replace(/^#/, '');
          if (digits.length > 10) {
            // Long number → this is actually an Order ID stored as the display name
            // Query Shopify by numeric ID
            workList.push({ key: rawName, queryStr: `id:${digits}` });
          } else {
            // Normal order name → query by name
            const name = rawName.startsWith('#') ? rawName : '#' + rawName;
            workList.push({ key: rawName, queryStr: `name:${name}` });
          }
        }

        // numericIds → always query by id:
        for (const nid of numericIds) {
          const digits = String(nid).replace(/\D/g, '');
          if (digits) workList.push({ key: digits, queryStr: `id:${digits}` });
        }

        if (!workList.length) return json({ orders: [] });

        // Deduplicate by queryStr to avoid double-fetching same order
        const seen      = new Set();
        const uniqueWork = workList.filter(w => {
          if (seen.has(w.queryStr)) return false;
          seen.add(w.queryStr);
          return true;
        });

        // Process in batches of 10 (parallel within each batch)
        const resultMap = {}; // queryStr → result
        for (let i = 0; i < uniqueWork.length; i += 10) {
          const batch = uniqueWork.slice(i, i + 10);
          const batchResults = await Promise.all(
            batch.map(async ({ queryStr }) => {
              const result = await lookupOneOrder(env, token, queryStr);
              return { queryStr, result };
            })
          );
          for (const { queryStr, result } of batchResults) {
            resultMap[queryStr] = result;
          }
        }

        // Build final response — one entry per work item (including originals)
        const orders = workList.map(({ key, queryStr }) => {
          const result = resultMap[queryStr];
          if (!result) return { name: key.startsWith('#') ? key : '#' + key, numericId: key, found: false };
          return result;
        });

        return json({ orders });
      }

      return json({ error: 'Unknown action' }, 400);

    } catch (err) {
      console.error('[ready-to-ship-worker]', err.message);
      return json({ error: err.message }, 500);
    }
  },
};
