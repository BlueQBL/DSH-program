-- 导出全业务工单相关标准码分类及码值（供本地解析）
SET FEEDBACK OFF
SET HEADING OFF
SET PAGESIZE 0
SET LINESIZE 4000
SET TRIMSPOOL ON
SET TERMOUT OFF
SET LONG 200000
SET LONGCHUNKSIZE 200000
SET SERVEROUTPUT OFF

SPOOL D:\study\jstudy\code\DSH-program\tools\dump_cls.txt
SELECT 'CLS|'||c.code_cls_id||'|'||c.code_cls_type||'|'||REPLACE(c.code_cls_name,'|','/')||'|'||NVL(c.std_code_cls_flag,'-')||'|'||NVL(c.valid_flag,'-')||'|'||NVL(c.prnt_code_cls_type,'-')||'|'||NVL(c.prnt_code_cls_val,'-')||'|'||NVL(c.rela_code_cls_type,'-')||'|'||NVL(c.rela_code_cls_val,'-')||'|'||TO_CHAR(c.valid_date,'YYYY-MM-DD')||'|'||TO_CHAR(c.invalid_date,'YYYY-MM-DD')
FROM fs_code_cls c
ORDER BY c.code_cls_id;
SPOOL OFF

SPOOL D:\study\jstudy\code\DSH-program\tools\dump_val.txt
SELECT 'VAL|'||v.code_cls_id||'|'||v.code_cls_type||'|'||v.code_cls_val||'|'||REPLACE(v.code_cls_val_name,'|','/')
FROM fs_code_cls_val v
ORDER BY v.code_cls_id, v.code_cls_val;
SPOOL OFF

SPOOL D:\study\jstudy\code\DSH-program\tools\dump_rng.txt
SELECT 'RNG|'||r.code_cls_val_id||'|'||r.app_code||'|'||v.code_cls_id||'|'||v.code_cls_type||'|'||v.code_cls_val
FROM fs_code_cls_val_app_rng r JOIN fs_code_cls_val v ON v.code_cls_val_id = r.code_cls_val_id
ORDER BY r.code_cls_val_id;
SPOOL OFF

EXIT
