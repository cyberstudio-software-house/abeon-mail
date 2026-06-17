use keyring::credential::{
    Credential, CredentialApi, CredentialBuilderApi, CredentialPersistence,
};
use std::any::Any;
use std::collections::HashMap;
use std::sync::{Mutex, Once};

pub(crate) static STORE: Mutex<Option<HashMap<(String, String), String>>> = Mutex::new(None);
static INIT: Once = Once::new();
pub(crate) static TEST_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn install_in_mem_builder() {
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
