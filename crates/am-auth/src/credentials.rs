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
    use keyring::credential::{
        Credential, CredentialApi, CredentialBuilderApi, CredentialPersistence,
    };
    use std::any::Any;
    use std::collections::HashMap;
    use std::sync::{Mutex, Once};

    static STORE: Mutex<Option<HashMap<(String, String), String>>> = Mutex::new(None);
    static INIT: Once = Once::new();

    fn install_in_mem_builder() {
        INIT.call_once(|| {
            *STORE.lock().unwrap() = Some(HashMap::new());
            keyring::set_default_credential_builder(Box::new(InMemCredBuilder));
        });
    }

    #[derive(Debug)]
    struct InMemCred {
        service: String,
        user: String,
    }

    impl CredentialApi for InMemCred {
        fn set_secret(&self, secret: &[u8]) -> keyring::Result<()> {
            let password = String::from_utf8(secret.to_vec())
                .map_err(|_| keyring::Error::BadEncoding(secret.to_vec()))?;
            let mut guard = STORE.lock().unwrap();
            let map = guard.as_mut().unwrap();
            map.insert((self.service.clone(), self.user.clone()), password);
            Ok(())
        }

        fn get_secret(&self) -> keyring::Result<Vec<u8>> {
            let guard = STORE.lock().unwrap();
            let map = guard.as_ref().unwrap();
            match map.get(&(self.service.clone(), self.user.clone())) {
                Some(pw) => Ok(pw.as_bytes().to_vec()),
                None => Err(keyring::Error::NoEntry),
            }
        }

        fn delete_credential(&self) -> keyring::Result<()> {
            let mut guard = STORE.lock().unwrap();
            let map = guard.as_mut().unwrap();
            match map.remove(&(self.service.clone(), self.user.clone())) {
                Some(_) => Ok(()),
                None => Err(keyring::Error::NoEntry),
            }
        }

        fn as_any(&self) -> &dyn Any {
            self
        }
    }

    struct InMemCredBuilder;

    impl CredentialBuilderApi for InMemCredBuilder {
        fn build(
            &self,
            _target: Option<&str>,
            service: &str,
            user: &str,
        ) -> keyring::Result<Box<Credential>> {
            Ok(Box::new(InMemCred {
                service: service.to_string(),
                user: user.to_string(),
            }))
        }

        fn as_any(&self) -> &dyn Any {
            self
        }

        fn persistence(&self) -> CredentialPersistence {
            CredentialPersistence::ProcessOnly
        }
    }

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn store_and_load_roundtrip() {
        install_in_mem_builder();
        let _guard = TEST_LOCK.lock().unwrap();
        let account = "roundtrip@test.abeonmail";
        let _ = delete_password(account);
        store_password(account, "secret").unwrap();
        let loaded = load_password(account).unwrap();
        assert_eq!(loaded, "secret");
        let _ = delete_password(account);
    }

    #[test]
    fn delete_then_load_errors() {
        install_in_mem_builder();
        let _guard = TEST_LOCK.lock().unwrap();
        let account = "deltest@test.abeonmail";
        let _ = delete_password(account);
        store_password(account, "pw").unwrap();
        delete_password(account).unwrap();
        let result = load_password(account);
        assert!(result.is_err());
    }

    #[test]
    fn mock_store_single_entry_lifecycle() {
        install_in_mem_builder();
        let _guard = TEST_LOCK.lock().unwrap();
        let entry = keyring::Entry::new("AbeonMail", "lifecycle@test.abeonmail").unwrap();
        entry.set_password("pw").unwrap();
        assert_eq!(entry.get_password().unwrap(), "pw");
        entry.delete_credential().unwrap();
        assert!(entry.get_password().is_err());
    }
}
