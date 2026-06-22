use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::Rng;
use sha2::{Digest, Sha256};

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

pub fn generate_pkce() -> Pkce {
    let verifier: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(64)
        .map(char::from)
        .collect();
    let challenge = s256_challenge(&verifier);
    Pkce { verifier, challenge }
}

pub fn authorize_url(
    provider: &crate::oauth::OAuthProvider,
    client_id: &str,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
) -> String {
    let auth_uri = provider.auth_uri;
    let scope_enc = urlencoded(provider.scopes);
    let redirect_enc = urlencoded(redirect_uri);
    let challenge_enc = urlencoded(challenge);
    let state_enc = urlencoded(state);
    let client_id_enc = urlencoded(client_id);
    let extra = provider.extra_auth_params;
    format!(
        "{auth_uri}?client_id={client_id_enc}&redirect_uri={redirect_enc}\
         &response_type=code&scope={scope_enc}&state={state_enc}\
         &code_challenge={challenge_enc}&code_challenge_method=S256\
         &{extra}"
    )
}

fn s256_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let digest = hasher.finalize();
    URL_SAFE_NO_PAD.encode(digest)
}

fn urlencoded(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push_str(&format!("{b:02X}"));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s256_rfc7636_appendix_b_vector() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = s256_challenge(verifier);
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn authorize_url_contains_required_params() {
        let provider = crate::oauth::OAuthProvider::google();
        let url = authorize_url(&provider, "MY_CLIENT", "http://127.0.0.1:9999", "CHALLENGE_XYZ", "STATE_ABC");
        assert!(url.starts_with(crate::oauth::google::GOOGLE_AUTH_URI), "wrong auth endpoint");
        assert!(url.contains("client_id=MY_CLIENT"), "missing client_id");
        assert!(url.contains("response_type=code"), "missing response_type");
        assert!(url.contains("code_challenge=CHALLENGE_XYZ"), "missing code_challenge");
        assert!(url.contains("code_challenge_method=S256"), "missing method");
        assert!(url.contains("access_type=offline"), "missing access_type");
        assert!(url.contains("prompt=consent"), "missing prompt");
        assert!(url.contains("state=STATE_ABC"), "missing state");
        assert!(url.contains("redirect_uri="), "missing redirect_uri");
    }

    #[test]
    fn authorize_url_uses_microsoft_provider_params() {
        let provider = crate::oauth::OAuthProvider::microsoft();
        let url = authorize_url(&provider, "MS_CLIENT", "http://127.0.0.1:9999", "CHAL", "STATE");
        assert!(url.starts_with(crate::oauth::microsoft::MICROSOFT_AUTH_URI), "wrong auth endpoint");
        assert!(url.contains("prompt=select_account"), "missing select_account prompt");
        assert!(!url.contains("access_type=offline"), "google-only param leaked");
        assert!(url.contains("IMAP.AccessAsUser.All"), "missing imap scope");
    }

    #[test]
    fn generate_pkce_challenge_matches_verifier() {
        let pkce = generate_pkce();
        let recomputed = s256_challenge(&pkce.verifier);
        assert_eq!(pkce.challenge, recomputed);
    }
}
