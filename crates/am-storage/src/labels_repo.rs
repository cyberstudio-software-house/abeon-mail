use am_core::label::Label;
use rusqlite::params;

use crate::db::{Database, StorageError};

pub fn list_labels(db: &Database) -> Result<Vec<Label>, StorageError> {
    let conn = db.conn();
    let mut stmt = conn.prepare("SELECT id, name, color FROM labels ORDER BY position, name")?;
    let rows = stmt.query_map([], |r| {
        Ok(Label { id: r.get(0)?, name: r.get(1)?, color: r.get(2)? })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn create_label(db: &Database, name: &str, color: &str) -> Result<Label, StorageError> {
    let conn = db.conn();
    conn.execute(
        "INSERT INTO labels (name, color) VALUES (?1, ?2)",
        params![name, color],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Label { id, name: name.to_string(), color: color.to_string() })
}

pub fn rename_label(db: &Database, id: i64, name: &str) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute("UPDATE labels SET name = ?2 WHERE id = ?1", params![id, name])?;
    Ok(())
}

pub fn set_label_color(db: &Database, id: i64, color: &str) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute("UPDATE labels SET color = ?2 WHERE id = ?1", params![id, color])?;
    Ok(())
}

pub fn delete_label(db: &Database, id: i64) -> Result<(), StorageError> {
    let conn = db.conn();
    conn.execute("DELETE FROM labels WHERE id = ?1", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_and_list_labels_ordered() {
        let db = Database::open_in_memory().unwrap();
        create_label(&db, "Work", "#4f46e5").unwrap();
        create_label(&db, "Personal", "#10b981").unwrap();

        let labels = list_labels(&db).unwrap();
        assert_eq!(labels.len(), 2);
        assert_eq!(labels[0].name, "Personal");
        assert_eq!(labels[1].name, "Work");
        assert_eq!(labels[1].color, "#4f46e5");
        assert!(labels[0].id > 0);
    }

    #[test]
    fn create_label_rejects_duplicate_name() {
        let db = Database::open_in_memory().unwrap();
        create_label(&db, "Work", "#4f46e5").unwrap();
        assert!(create_label(&db, "Work", "#10b981").is_err());
    }

    #[test]
    fn rename_and_recolor_label() {
        let db = Database::open_in_memory().unwrap();
        let l = create_label(&db, "Work", "#4f46e5").unwrap();
        rename_label(&db, l.id, "Job").unwrap();
        set_label_color(&db, l.id, "#ec4899").unwrap();

        let labels = list_labels(&db).unwrap();
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].name, "Job");
        assert_eq!(labels[0].color, "#ec4899");
    }

    #[test]
    fn delete_label_removes_row() {
        let db = Database::open_in_memory().unwrap();
        let l = create_label(&db, "Temp", "#0ea5e9").unwrap();
        delete_label(&db, l.id).unwrap();
        assert_eq!(list_labels(&db).unwrap().len(), 0);
    }
}
