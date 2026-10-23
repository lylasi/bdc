#!/bin/sh
set -eu

source_root=/src/bdc
web_root=/srv/bdc

if [ ! -f "$source_root/index.html" ] || [ -L "$source_root/index.html" ]; then
    printf '%s\n' '錯誤：/src/bdc 缺少一般檔案 index.html，請檢查 BDC_ROOT 掛載。' >&2
    exit 1
fi

mkdir -p "$web_root"
find "$web_root" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

# 只走訪指定目錄；find 預設不跟隨符號連結，亦不複製連結本身。
for directory in assets features modules locales shared wordlists articles qa-sets phonetic-chart; do
    if [ ! -d "$source_root/$directory" ] || [ -L "$source_root/$directory" ]; then
        continue
    fi
    mkdir -p "$web_root/$directory"
    (
        cd "$source_root/$directory"
        find . \
            \( -path '*/.*' -o -name docs -o -name scripts -o -name tests \
                -o -name selfhost -o -name cloudflare-worker -o -name article-import-service \
                -o -name node_modules -o -name deploy \
            \) -prune -o \
            -type f ! -iname '*.md' ! -iname '*.markdown' \
                ! -iname '*.map' ! -name 'test-*.html' \
                ! -name 'subset-chars.txt' \
                ! -name 'ai-config.example.js' ! -name 'ai-config.js' \
                -exec sh -eu -c '
                    destination=$1
                    shift
                    for file do
                        relative=${file#./}
                        mkdir -p "$destination/$(dirname "$relative")"
                        cp "$file" "$destination/$relative"
                    done
                ' sh "$web_root/$directory" {} +
    )
done

for file in index.html main.js styles.css phonetics.html voices.json voices.min.json voices.fallback.json 5AU1_1.jpg 5AU1_2.jpg ai-config.js; do
    if [ -f "$source_root/$file" ] && [ ! -L "$source_root/$file" ]; then
        cp "$source_root/$file" "$web_root/$file"
    elif [ "$file" = ai-config.js ]; then
        printf '%s\n' '警告：/src/bdc/ai-config.js 不存在或為符號連結；仍啟動靜態服務，相關功能可能無法使用。' >&2
    fi
done

find "$web_root" -type d -exec chmod 0755 {} +
find "$web_root" -type f -exec chmod 0644 {} +
printf '%s\n' 'BDC 執行期白名單已複製至 /srv/bdc。'
