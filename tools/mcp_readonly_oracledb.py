"""直连 Oracle 导出 FS_CODE_* 三张表全量数据到本地文件（绕开 MCP 工具的行/列截断）。

用法: python mcp_readonly_oracledb.py
输出: tools/out/cls.tsv, tools/out/val.tsv, tools/out/rng.tsv
"""
import os
import sys

try:
    import oracledb
except ImportError:
    print("MISSING_ORACLEDB")
    sys.exit(2)

DSN = "commondb/131426.Xxf.com@localhost:1521/orcl"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
os.makedirs(OUT, exist_ok=True)

QUERIES = {
    "cls": """
        SELECT code_cls_id, code_cls_type, code_cls_name, std_code_cls_flag, valid_flag,
               prnt_code_cls_type, prnt_code_cls_val, rela_code_cls_type, rela_code_cls_val,
               TO_CHAR(valid_date,'YYYY-MM-DD'), TO_CHAR(invalid_date,'YYYY-MM-DD')
        FROM fs_code_cls ORDER BY code_cls_id
    """,
    "val": """
        SELECT code_cls_val_id, code_cls_id, code_cls_type, code_cls_val, code_cls_val_name
        FROM fs_code_cls_val ORDER BY code_cls_id, code_cls_val
    """,
    "rng": """
        SELECT r.code_cls_val_app_rng_id, r.app_code, r.code_cls_val_id,
               v.code_cls_id, v.code_cls_type, v.code_cls_val
        FROM fs_code_cls_val_app_rng r
        JOIN fs_code_cls_val v ON v.code_cls_val_id = r.code_cls_val_id
        ORDER BY r.code_cls_val_id
    """,
}


def main() -> int:
    conn = oracledb.connect(user="commondb", password="131426.Xxf.com",
                            dsn="localhost:1521/orcl")
    cur = conn.cursor()
    for name, sql in QUERIES.items():
        cur.execute(sql)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        path = os.path.join(OUT, name + ".tsv")
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\t".join(cols) + "\n")
            for row in rows:
                # 单元格内的换行/制表符压平，保证 TSV 可解析
                cells = ["" if v is None else str(v).replace("\r", " ").replace("\n", " ").replace("\t", " ")
                         for v in row]
                fh.write("\t".join(cells) + "\n")
        print(f"{name}\trows={len(rows)}\tcols={len(cols)}\t{path}")
    cur.close()
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
