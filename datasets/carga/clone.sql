-- Clonagem de lojas de carga a partir de lojas-molde que a própria
-- aplicação criou (comando `sellvex marketplace --local`). Cada loja nova é
-- uma cópia linha a linha de uma loja-molde, com todo identificador
-- remapeado para um uuidv7 novo: as invariantes que a API impõe (status,
-- célula, placement, módulos, preço por lista, estoque = soma dos
-- movimentos, listagem pública) vêm prontas da loja-molde, porque foi a API
-- que as gravou ali.
--
-- Marcador: o schema `carga` (fora dos schemas da aplicação) guarda o
-- registro de toda loja criada; o nome da loja começa por "Carga " e o da
-- organização por "carga-". A remoção (remove.sql) lê só esse registro.
--
-- Não clona: audit.events (histórico append-only, medido à parte por loja
-- para extrapolação), pedidos, carrinhos e mídia (as lojas-molde não têm
-- imagem de produto).

create schema if not exists carga;

create table if not exists carga.lojas (
    seq             integer primary key,
    store_id        uuid not null unique,
    organization_id uuid not null,
    account_id      uuid not null,
    template        uuid not null,
    created_at      timestamptz not null default now()
);

create table if not exists carga.moldes (
    pos      integer primary key,
    store_id uuid not null unique
);

-- Todo uuid de linha das lojas-molde que precisa de remapeamento.
create or replace view carga.ids_molde as
    select m.store_id as tpl, s.organization_id as old from carga.moldes m join stores.stores s on s.id = m.store_id
    union all select m.store_id, s.account_id from carga.moldes m join stores.stores s on s.id = m.store_id
    union all select m.store_id, m.store_id from carga.moldes m
    union all select c.store_id, c.id from catalog.categories c join carga.moldes m on m.store_id = c.store_id
    union all select p.store_id, p.id from catalog.products p join carga.moldes m on m.store_id = p.store_id
    union all select v.store_id, v.id from catalog.variants v join carga.moldes m on m.store_id = v.store_id
    union all select w.store_id, w.id from inventory.warehouses w join carga.moldes m on m.store_id = w.store_id
    union all select l.store_id, l.id from pricing.price_lists l join carga.moldes m on m.store_id = l.store_id;

create or replace function carga.clonar(p_from integer, p_to integer) returns integer
language plpgsql as $$
declare
    n_moldes integer;
begin
    select count(*) into n_moldes from carga.moldes;
    if n_moldes = 0 then raise exception 'carga.moldes vazio'; end if;

    create temp table b on commit drop as
        select g.seq, m.store_id as tpl
        from generate_series(p_from, p_to) g(seq)
        join carga.moldes m on m.pos = g.seq % n_moldes
        where not exists (select 1 from carga.lojas l where l.seq = g.seq);

    create temp table mp on commit drop as
        select b.seq, i.old, uuidv7() as new from b join carga.ids_molde i on i.tpl = b.tpl;
    create unique index on mp (seq, old);
    analyze mp;

    insert into organizations.organizations (id, name, created_at, updated_at, version)
    select mo.new, 'carga-' || lpad(b.seq::text, 6, '0'), now(), now(), 1
    from b join stores.stores s on s.id = b.tpl join mp mo on mo.seq = b.seq and mo.old = s.organization_id;

    insert into organizations.accounts (id, organization_id, name, created_at, updated_at, version)
    select ma.new, mo.new, 'carga-' || lpad(b.seq::text, 6, '0'), now(), now(), 1
    from b join stores.stores s on s.id = b.tpl
    join mp ma on ma.seq = b.seq and ma.old = s.account_id
    join mp mo on mo.seq = b.seq and mo.old = s.organization_id;

    insert into stores.stores (id, organization_id, account_id, name, country, default_locale, timezone, default_currency,
                               home_region, status, cell_id, created_at, updated_at, version, paused, suspended,
                               suspended_reason, suspended_by, suspended_reason_code, suspended_by_level, suspended_at)
    select ms.new, mo.new, ma.new, 'Carga ' || lpad(b.seq::text, 6, '0') || ' ' || s.name, s.country, s.default_locale, s.timezone,
           s.default_currency, s.home_region, s.status, s.cell_id, now(), now(), 1, false, false, '', '', '', '', null
    from b join stores.stores s on s.id = b.tpl
    join mp ms on ms.seq = b.seq and ms.old = s.id
    join mp mo on mo.seq = b.seq and mo.old = s.organization_id
    join mp ma on ma.seq = b.seq and ma.old = s.account_id;

    insert into controlplane.placements (store_id, organization_id, cell_id, placed_at)
    select ms.new, mo.new, p.cell_id, now()
    from b join controlplane.placements p on p.store_id = b.tpl
    join mp ms on ms.seq = b.seq and ms.old = p.store_id
    join mp mo on mo.seq = b.seq and mo.old = p.organization_id;

    insert into controlplane.module_installations (store_id, organization_id, module_id, module_version, status,
                                                   retention_until, created_at, updated_at, version)
    select ms.new, mo.new, i.module_id, i.module_version, i.status, i.retention_until, now(), now(), i.version
    from b join controlplane.module_installations i on i.store_id = b.tpl
    join mp ms on ms.seq = b.seq and ms.old = i.store_id
    join mp mo on mo.seq = b.seq and mo.old = i.organization_id;

    insert into catalog.categories (id, store_id, parent_id, name, slug, position, created_at, updated_at)
    select mc.new, ms.new, coalesce(mpar.new, c.parent_id), c.name, c.slug, c.position, now(), now()
    from b join catalog.categories c on c.store_id = b.tpl
    join mp mc on mc.seq = b.seq and mc.old = c.id
    join mp ms on ms.seq = b.seq and ms.old = c.store_id
    left join mp mpar on mpar.seq = b.seq and mpar.old = c.parent_id;

    insert into catalog.products (id, store_id, organization_id, title, description, status, published_at,
                                  created_at, updated_at, version, brand)
    select mpr.new, ms.new, mo.new, p.title, p.description, p.status, case when p.published_at is null then null else now() end,
           now(), now(), p.version, p.brand
    from b join catalog.products p on p.store_id = b.tpl
    join mp mpr on mpr.seq = b.seq and mpr.old = p.id
    join mp ms on ms.seq = b.seq and ms.old = p.store_id
    join mp mo on mo.seq = b.seq and mo.old = p.organization_id;

    insert into catalog.variants (id, product_id, store_id, sku, title, created_at)
    select mv.new, mpr.new, ms.new, v.sku, v.title, now()
    from b join catalog.variants v on v.store_id = b.tpl
    join mp mv on mv.seq = b.seq and mv.old = v.id
    join mp mpr on mpr.seq = b.seq and mpr.old = v.product_id
    join mp ms on ms.seq = b.seq and ms.old = v.store_id;

    insert into catalog.product_categories (product_id, category_id, store_id)
    select mpr.new, coalesce(mc.new, pc.category_id), ms.new
    from b join catalog.product_categories pc on pc.store_id = b.tpl
    join mp mpr on mpr.seq = b.seq and mpr.old = pc.product_id
    join mp ms on ms.seq = b.seq and ms.old = pc.store_id
    left join mp mc on mc.seq = b.seq and mc.old = pc.category_id;

    insert into inventory.warehouses (id, store_id, organization_id, name, status, created_at, updated_at, priority)
    select mw.new, ms.new, mo.new, w.name, w.status, now(), now(), w.priority
    from b join inventory.warehouses w on w.store_id = b.tpl
    join mp mw on mw.seq = b.seq and mw.old = w.id
    join mp ms on ms.seq = b.seq and ms.old = w.store_id
    join mp mo on mo.seq = b.seq and mo.old = w.organization_id;

    insert into inventory.stock_positions (warehouse_id, variant_id, store_id, on_hand, reserved, created_at, updated_at)
    select mw.new, mv.new, ms.new, sp.on_hand, sp.reserved, now(), now()
    from b join inventory.stock_positions sp on sp.store_id = b.tpl
    join mp mw on mw.seq = b.seq and mw.old = sp.warehouse_id
    join mp mv on mv.seq = b.seq and mv.old = sp.variant_id
    join mp ms on ms.seq = b.seq and ms.old = sp.store_id;

    insert into inventory.movements (store_id, warehouse_id, variant_id, kind, on_hand_delta, reserved_delta,
                                     reference, reason, actor_id, occurred_at)
    select ms.new, mw.new, mv.new, mv0.kind, mv0.on_hand_delta, mv0.reserved_delta, mv0.reference,
           'carga sintética k6 (clone de loja-molde)', mv0.actor_id, now()
    from b join inventory.movements mv0 on mv0.store_id = b.tpl
    join mp mw on mw.seq = b.seq and mw.old = mv0.warehouse_id
    join mp mv on mv.seq = b.seq and mv.old = mv0.variant_id
    join mp ms on ms.seq = b.seq and ms.old = mv0.store_id;

    insert into pricing.price_lists (id, store_id, organization_id, name, currency, priority, valid_from, valid_until,
                                     status, created_at, updated_at, version)
    select ml.new, ms.new, mo.new, l.name, l.currency, l.priority, l.valid_from, l.valid_until, l.status, now(), now(), l.version
    from b join pricing.price_lists l on l.store_id = b.tpl
    join mp ml on ml.seq = b.seq and ml.old = l.id
    join mp ms on ms.seq = b.seq and ms.old = l.store_id
    join mp mo on mo.seq = b.seq and mo.old = l.organization_id;

    insert into pricing.price_entries (price_list_id, store_id, variant_id, price_amount, created_at, updated_at)
    select ml.new, ms.new, mv.new, e.price_amount, now(), now()
    from b join pricing.price_entries e on e.store_id = b.tpl
    join mp ml on ml.seq = b.seq and ml.old = e.price_list_id
    join mp mv on mv.seq = b.seq and mv.old = e.variant_id
    join mp ms on ms.seq = b.seq and ms.old = e.store_id;

    insert into listings.listings (store_id, product_id, organization_id, title, listed, search_text, version, listed_at, updated_at)
    select ms.new, mpr.new, mo.new, l.title, l.listed, l.search_text, l.version, case when l.listed_at is null then null else now() end, now()
    from b join listings.listings l on l.store_id = b.tpl
    join mp ms on ms.seq = b.seq and ms.old = l.store_id
    join mp mpr on mpr.seq = b.seq and mpr.old = l.product_id
    join mp mo on mo.seq = b.seq and mo.old = l.organization_id;

    insert into carga.lojas (seq, store_id, organization_id, account_id, template)
    select b.seq, ms.new, mo.new, ma.new, b.tpl
    from b join stores.stores s on s.id = b.tpl
    join mp ms on ms.seq = b.seq and ms.old = s.id
    join mp mo on mo.seq = b.seq and mo.old = s.organization_id
    join mp ma on ma.seq = b.seq and ma.old = s.account_id;

    return (select count(*) from b);
end $$;
