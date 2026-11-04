`meta.svg` is the Meta logo used by Magpie, copied from
[`yetone/magpie` at `14f6d10`](https://github.com/yetone/magpie/blob/14f6d10de086a4d0b74d4a82d16fa1fa6a30f543/internal/gui/assets/icons/meta-color.svg).
The identical SVG is embedded as a base64 data URI in `package.json` →
`magpie.icon` so installed providers and discovery cards can display it without
an external image request. Keep the file and embedded value synchronized.
