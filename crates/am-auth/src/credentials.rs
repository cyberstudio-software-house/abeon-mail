use crate::AuthError;

const SERVICE: &str = "AbeonMail";

pub fn store_password(account_ref: &str, password: &str) -> Result<(), AuthError> {
    let entry = keyring::Entry::new(SERVICE, account_ref)?;
    entry.set_password(password)?;
    Ok(())
}

pub fn load_password(account_ref: &str) -> Result<String, AuthError> {
    let entry = keyring::Entry::new(SERVICE, account_ref)?;
    let password = entry.get_password()?;
    Ok(password)
}

pub fn delete_password(account_ref: &str) -> Result<(), AuthError> {
    let entry = keyring::Entry::new(SERVICE, account_ref)?;
    entry.delete_credential()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_and_load_roundtrip() {
        crate::test_keychain::install_in_mem_builder();
        let _guard = crate::test_keychain::TEST_LOCK.lock().unwrap();
        let account = "roundtrip@test.abeonmail";
        let _ = delete_password(account);
        store_password(account, "secret").unwrap();
        let loaded = load_password(account).unwrap();
        assert_eq!(loaded, "secret");
        let _ = delete_password(account);
    }

    #[test]
    fn delete_then_load_errors() {
        crate::test_keychain::install_in_mem_builder();
        let _guard = crate::test_keychain::TEST_LOCK.lock().unwrap();
        let account = "deltest@test.abeonmail";
        let _ = delete_password(account);
        store_password(account, "pw").unwrap();
        delete_password(account).unwrap();
        let result = load_password(account);
        assert!(result.is_err());
    }

    #[test]
    fn mock_store_single_entry_lifecycle() {
        crate::test_keychain::install_in_mem_builder();
        let _guard = crate::test_keychain::TEST_LOCK.lock().unwrap();
        let entry = keyring::Entry::new("AbeonMail", "lifecycle@test.abeonmail").unwrap();
        entry.set_password("pw").unwrap();
        assert_eq!(entry.get_password().unwrap(), "pw");
        entry.delete_credential().unwrap();
        assert!(entry.get_password().is_err());
    }
}
