"""探测 Oracle 可见 schema / 表 / 字典语义（纯只读）。"""
import oracledb

c = oracledb.connect(user="commondb", password="131426.Xxf.com", dsn="localhost:1521/orcl")
cur = c.cursor()

print("--- all_users ---")
cur.execute("SELECT username FROM all_users ORDER BY username")
print(", ".join(r[0] for r in cur.fetchall()))

print("--- all_tables count by owner ---")
cur.execute("SELECT owner, COUNT(*) FROM all_tables GROUP BY owner ORDER BY owner")
for r in cur.fetchall():
    print(f"{r[0]}\t{r[1]}")

print("--- tables (owner.table) ---")
cur.execute("SELECT owner, table_name FROM all_tables ORDER BY owner, table_name")
rows = cur.fetchall()
print("count=", len(rows))
for r in rows:
    print(f"{r[0]}.{r[1]}")

print("--- 是否存在码分类定义/平台字典表 ---")
cur.execute(
    "SELECT owner, table_name FROM all_tables "
    "WHERE table_name LIKE '%CODE%' OR table_name LIKE '%DICT%' OR table_name LIKE '%CODE_CLS%' "
    "ORDER BY owner, table_name"
)
for r in cur.fetchall():
    print(f"{r[0]}.{r[1]}")

cur.close()
c.close()
