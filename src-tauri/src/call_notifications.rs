//! Native background acknowledgements use the same NIP-59 envelopes as the client.
//! Keys never enter notification intents or the WebView action payload.
use nostr::{EventBuilder, JsonUtil, Keys, Kind, PublicKey, Tag};

async fn reply(
    secret: &str,
    peer: &str,
    content: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let value: serde_json::Value = serde_json::from_str(content)?;
    if content.len() > 4096
        || value["protocol"] != "anagram/iroh-call/1"
        || !(value["action"] == "ringing"
            || (value["action"] == "end"
                && matches!(value["reason"].as_str(), Some("declined" | "busy"))))
    {
        return Err("Invalid background call response".into());
    }
    let keys = Keys::parse(secret)?;
    let peer = PublicKey::from_hex(peer)?;
    let rumor = EventBuilder::new(Kind::Custom(21117), content)
        .tags([Tag::public_key(peer)])
        .build(keys.public_key());
    Ok(EventBuilder::gift_wrap(&keys, &peer, rumor, [])
        .await?
        .as_json())
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_nostr_anagram_CallSignalNative_reply(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    secret: jni::objects::JString,
    peer: jni::objects::JString,
    content: jni::objects::JString,
) -> jni::sys::jstring {
    // Never propagate a Rust panic or a key-containing error through JNI.
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let secret: String = env.get_string(&secret).ok()?.into();
        let peer: String = env.get_string(&peer).ok()?.into();
        let content: String = env.get_string(&content).ok()?.into();
        let response = tauri::async_runtime::block_on(reply(&secret, &peer, &content)).ok()?;
        env.new_string(response).ok().map(|value| value.into_raw())
    }))
    .ok()
    .flatten()
    .unwrap_or(std::ptr::null_mut())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{nips::nip59::UnwrappedGift, Event};
    #[test]
    fn responses_are_signed_encrypted_and_bound_to_the_recipient() {
        tauri::async_runtime::block_on(async {
            let sender = Keys::generate();
            let recipient = Keys::generate();
            for (action, reason) in [
                ("ringing", None),
                ("end", Some("declined")),
                ("end", Some("busy")),
            ] {
                let content = serde_json::json!({"protocol":"anagram/iroh-call/1", "action":action, "reason":reason}).to_string();
                let encoded = reply(
                    &sender.secret_key().to_secret_hex(),
                    &recipient.public_key().to_hex(),
                    &content,
                )
                .await
                .unwrap();
                let event = Event::from_json(encoded).unwrap();
                event.verify().unwrap();
                let gift = UnwrappedGift::from_gift_wrap(&recipient, &event)
                    .await
                    .unwrap();
                assert_eq!(gift.sender, sender.public_key());
                assert_eq!(gift.rumor.kind, Kind::Custom(21117));
                assert_eq!(gift.rumor.content, content);
                assert!(UnwrappedGift::from_gift_wrap(&Keys::generate(), &event)
                    .await
                    .is_err());
            }
            assert!(reply(
                &sender.secret_key().to_secret_hex(),
                &recipient.public_key().to_hex(),
                r#"{"protocol":"anagram/iroh-call/1","action":"accept"}"#
            )
            .await
            .is_err());
        });
    }
}
