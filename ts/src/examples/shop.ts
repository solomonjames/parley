// A meal-delivery shop that speaks Parley. Shows budgets (a big catalog, fitted to the
// agent's token budget with EXPAND handles), money (cost on every proposal, spend caps
// in grants) and human consent for anything over the agent's limits.
import {
  ParleyError,
  charge,
  create,
  fix,
  money,
  service,
  type Plan,
} from '../index.js';

const MENU: [string, string[]][] = [
  ['Miso Glazed Salmon', ['high-protein']],
  ['Chicken Tikka Masala', ['high-protein', 'spicy']],
  ['Mushroom Risotto', ['vegetarian']],
  ['Beef Bulgogi Bowl', ['high-protein', 'spicy']],
  ['Falafel Plate', ['vegan', 'vegetarian']],
  ['Turkey Chili', ['high-protein', 'spicy']],
  ['Tofu Pad Thai', ['vegan', 'vegetarian']],
  ['Lemon Herb Chicken', ['high-protein']],
  ['Shrimp Tacos', ['spicy']],
  ['Lentil Curry', ['vegan', 'vegetarian', 'spicy']],
  ['Steak Frites', ['high-protein']],
  ['Veggie Lasagna', ['vegetarian']],
  ['Cod Piccata', ['high-protein']],
  ['Pork Carnitas', ['high-protein']],
  ['Chickpea Shawarma', ['vegan', 'vegetarian']],
  ['Teriyaki Chicken', ['high-protein']],
  ['Eggplant Parm', ['vegetarian']],
  ['Salmon Poke', ['high-protein']],
  ['Chicken Pho', ['high-protein']],
  ['Black Bean Burrito', ['vegan', 'vegetarian']],
];

export interface Meal {
  sku: string;
  name: string;
  price: number;
  cal: number;
  protein: number;
  tags: string[];
}

export const catalog: Meal[] = Array.from({ length: 60 }, (_, i) => ({
  sku: `m${String(i + 1).padStart(3, '0')}`,
  name:
    MENU[i % MENU.length][0] +
    (i >= MENU.length
      ? ` (${['family', 'light'][Math.floor(i / MENU.length) - 1]})`
      : ''),
  price: 1099 + ((i * 137) % 900),
  cal: 420 + ((i * 53) % 380),
  protein: 18 + ((i * 7) % 30),
  tags: MENU[i % MENU.length][1],
}));

export function shop(opts: {
  trust: string[] | ((principal: string) => boolean);
  id?: string;
}) {
  const orders = new Map<
    string,
    { id: string; total: number; status: string }
  >();
  let seq = 1000;

  return service({
    id: opts.id ?? 'shop.example',
    name: 'Example Meals',
    summary:
      'Chef-made meal delivery. Search the menu, then order for a delivery date. Orders can be cancelled for 2 hours.',
    trust: opts.trust,
  })
    .ask('shop.search', {
      summary: 'Search the menu',
      params: {
        'query?': 'string',
        'tag?': 'high-protein|spicy|vegetarian|vegan',
        'max_cal?': 'int',
      },
      run: ({ params }) =>
        catalog
          .filter(
            (m) =>
              !params.query ||
              m.name.toLowerCase().includes(String(params.query).toLowerCase()),
          )
          .filter((m) => !params.tag || m.tags.includes(params.tag))
          .filter((m) => !params.max_cal || m.cal <= params.max_cal)
          .map((m) => ({
            sku: m.sku,
            name: m.name,
            usd: m.price / 100,
            cal: m.cal,
            protein: m.protein,
          })),
    })
    .ask('shop.orders', {
      summary: 'Your orders',
      run: () =>
        [...orders.values()].map((o) => ({
          id: o.id,
          usd: o.total / 100,
          status: o.status,
        })),
    })
    .intent('shop.order', {
      summary: 'Order meals for delivery',
      params: { items: [{ sku: 'string', qty: 'int' }], deliver: 'date' },
      risk: 'low',
      plan: ({ params }) => {
        const items: { sku: string; qty: number }[] = params.items;
        const lines = items.map((it) => {
          const m = catalog.find((c) => c.sku === it.sku);

          if (!m)
            throw new ParleyError(
              'invalid_params',
              `unknown sku ${JSON.stringify(it.sku)}`,
              { fix: [fix('ASK shop.search to find skus')] },
            );

          return { ...m, qty: it.qty };
        });
        const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
        const fee = subtotal >= 5000 ? 0 : 599;
        const order = (express: boolean): Plan => {
          const total = subtotal + fee + (express ? 899 : 0);
          const id = `o${++seq}`;

          return {
            summary: `${lines.reduce((n, l) => n + l.qty, 0)} meals for ${params.deliver}${express ? ' (express, by noon)' : ''} — ${(total / 100).toFixed(2)} USD`,
            effects: [
              create(
                `order/${id}`,
                lines.map((l) => `${l.qty}× ${l.name}`).join(', '),
              ),
              charge('card ••4242', `${(total / 100).toFixed(2)} USD`),
            ],
            cost: money(total),
            risk: total > 15000 ? 'high' : total > 8000 ? 'medium' : 'low',
            undoWindow: 7200,
            data: {
              subtotal: subtotal / 100,
              delivery: fee / 100,
              ...(express ? { express: 8.99 } : {}),
            },
            apply: (ctx) => {
              ctx.progress('authorizing card', 0.3);
              ctx.progress('order placed with kitchen', 0.9);
              orders.set(id, { id, total, status: 'placed' });

              return { order: id, status: 'placed' };
            },
            revert: () => {
              orders.get(id)!.status = 'cancelled';
            },
          };
        };

        return [order(false), order(true)];
      },
    })
    .intent('shop.tip', {
      summary: 'Tip your courier (irreversible)',
      params: { order: 'string', usd: 'number' },
      risk: 'medium',
      plan: ({ params }) => ({
        summary: `Tip ${params.usd} USD on ${params.order}`,
        effects: [charge('card ••4242', `tip ${params.usd} USD`)],
        cost: money(Math.round(params.usd * 100)),
        apply: () => ({ tipped: params.usd }),
      }),
    });
}
