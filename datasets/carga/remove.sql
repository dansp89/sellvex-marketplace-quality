-- Remove tudo o que o semeador de carga e os cenários k6 criaram, lendo só
-- o registro carga.lojas. Nada fora dele é tocado.
--
-- inventory.movements e audit.events são append-only por
-- gatilho; dentro desta transação só esses gatilhos são desligados (DDL
-- transacional: falhou, volta tudo). As chaves estrangeiras continuam
-- valendo; por isso as tabelas são apagadas em passadas repetidas, cada
-- uma num savepoint, até nenhuma avançar — a ordem dos filhos sai sozinha.
-- As linhas que os cenários de checkout gravaram (carrinhos, checkouts,
-- pedidos, pagamentos, reservas, ledger, auditoria) saem pelo store_id.
begin;
alter table inventory.movements disable trigger tr_movements__append_only;
alter table audit.events disable trigger user;

create temp table alvo on commit drop as select store_id, organization_id, account_id from carga.lojas;
create index on alvo (store_id);
analyze alvo;

do $$
declare
    r record;
    pend text[] := '{}';
    falhas integer;
    ultimo text;
begin
    -- toda tabela base (não partição) com coluna store_id, exceto stores.stores
    for r in
        select n.nspname as s, c.relname as t
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        where a.attname = 'store_id' and not a.attisdropped
          and c.relkind in ('r', 'p') and not c.relispartition
          and n.nspname not in ('carga', 'pg_catalog', 'information_schema') and n.nspname !~ '^pg_(temp|toast)'
          and not (n.nspname = 'stores' and c.relname = 'stores')
    loop
        pend := pend || format('%I.%I', r.s, r.t);
    end loop;
    for passada in 1..20 loop
        falhas := 0;
        for i in 1..coalesce(array_length(pend, 1), 0) loop
            begin
                execute format('delete from %s x using alvo where x.store_id = alvo.store_id', pend[i]);
            exception when foreign_key_violation then
                falhas := falhas + 1;
                ultimo := pend[i] || ': ' || sqlerrm;
            end;
        end loop;
        exit when falhas = 0;
    end loop;
    if falhas > 0 then raise exception 'remoção travada por chave estrangeira: %', ultimo; end if;
end $$;

delete from identity.memberships m using alvo where m.store_id = alvo.store_id;
delete from stores.stores s using alvo where s.id = alvo.store_id;
delete from organizations.accounts a using alvo where a.id = alvo.account_id;
delete from organizations.organizations o using alvo where o.id = alvo.organization_id;

alter table inventory.movements enable trigger tr_movements__append_only;
alter table audit.events enable trigger user;
drop schema carga cascade;
commit;
