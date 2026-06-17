use crate::endpoints::Endpoints;

pub struct PasswordProvider {
    pub email: String,
    pub endpoints: Endpoints,
}

impl PasswordProvider {
    pub fn endpoints(&self) -> &Endpoints {
        &self.endpoints
    }
}
