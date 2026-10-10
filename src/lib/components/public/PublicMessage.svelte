<script lang="ts">
  import { publicGroupLinkTarget } from '#src/utils/publicGroupLink.ts';
  import type { NostrEvent } from '#src/lib/nostr/client.ts';
  import {
    formatMessage,
    messageFormatUrls,
    type FormattedMessagePart,
  } from '#src/utils/messageFormatting.ts';
  import { previewUrl } from '#src/utils/linkPreview.ts';
  import type { Message } from '#src/types/chat.ts';
  import { publicMessageForDisplay, redactPublicLinks } from '#src/utils/publicMessage.ts';
  import MessageBody from '../MessageBody.svelte';
  import { openExternalHttpUrl } from '#src/utils/externalLinks.ts';
  export let event: NostrEvent;
  export let displayMessage: Message | undefined = undefined;
  export let trusted = false;
  export let bubbleLayout = false;
  export let oncontact: (publicKey: string) => void = () => {};
  // Untrusted senders supply literal text parts, with no rich parsing, links or media.
  function safeParts(parts: FormattedMessagePart[]): FormattedMessagePart[] {
    return parts.map((p) =>
      p.type === 'format'
        ? { ...p, children: safeParts(p.children) }
        : p.type === 'url' && !publicGroupLinkTarget(p.href) && !previewUrl(p.href)
          ? { type: 'text', text: p.text, key: p.key }
          : p,
    );
  }
  let parts: FormattedMessagePart[];
  $: parts = trusted
    ? safeParts(formatMessage(event.content))
    : [{ type: 'text', text: redactPublicLinks(event.content), key: 'plain' }];
  $: urls = trusted
    ? messageFormatUrls(parts)
    : { visible: new Set<string>(), hidden: new Set<string>() };
  $: media = trusted
    ? [
        ...new Map(
          [
            ...[...urls.visible].flatMap((url) =>
              /\.(png|jpg|jpeg|gif|webp|avif|mp4|webm|ogv)(?:[?#]|$)/i.test(url)
                ? [
                    {
                      url,
                      kind: /\.(mp4|webm|ogv)(?:[?#]|$)/i.test(url)
                        ? ('video' as const)
                        : ('image' as const),
                    },
                  ]
                : [],
            ),
            ...event.tags
              .filter((t) => t[0] === 'imeta')
              .flatMap((t) => {
                const url = t.find((v) => v.startsWith('url '))?.slice(4) || '';
                const mime = t.find((v) => v.startsWith('m '))?.slice(2) || '';
                return url &&
                  (!urls.hidden.has(url) || urls.visible.has(url)) &&
                  /^(image|video)\//.test(mime)
                  ? [
                      {
                        url,
                        kind: mime.startsWith('video/') ? ('video' as const) : ('image' as const),
                      },
                    ]
                  : [];
              }),
          ]
            .filter((m) => previewUrl(m.url))
            .map((m) => [m.url, m]),
        ).values(),
      ].slice(0, 4)
    : [];
  $: message = {
    ...(displayMessage ?? publicMessageForDisplay(event)),
    meta: {
      ...displayMessage?.meta,
      attachments: media.map((item) => ({
        type: 'media',
        url: item.url,
        mimeType: `${item.kind}/${item.kind === 'image' ? 'png' : 'mp4'}`,
        size: 0,
      })),
    },
  } satisfies Message;
</script>

<MessageBody
  {message}
  formattedParts={parts}
  allowMedia={trusted}
  {bubbleLayout}
  {oncontact}
  onroom={(url) => {
    if (previewUrl(url)) void openExternalHttpUrl(url);
  }}
/>
