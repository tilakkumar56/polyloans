Set-Content -Path debug_scan.js -Value "const axios = require('axios');

// 👇 REPLACE THIS WITH YOUR NEW WALLET ADDRESS 👇
const TARGET_WALLET = '0xf18e5D8c694163a61BFe10CA3197290611F038E5'; 

async function debug() {
    console.log('\n🔍 STARTING DEBUG SCAN FOR: ' + TARGET_WALLET + '\n');

    let proxy = null;
    try {
        console.log('1️⃣  Checking for Proxy Wallet...');
        const r = await axios.get('https://gamma-api.polymarket.com/users/' + TARGET_WALLET.toLowerCase());
        if (r.data && r.data.proxyWallet) {
            proxy = r.data.proxyWallet;
            console.log('   ✅ FOUND PROXY: ' + proxy);
        } else {
            console.log('   ❌ No Proxy found (User might be new or inactive)');
        }
    } catch (e) { console.log('   ⚠️  Proxy API Error: ' + e.message); }

    const addresses = [TARGET_WALLET];
    if (proxy) addresses.push(proxy);

    for (const addr of addresses) {
        console.log('\n2️⃣  Scanning Address: ' + addr);
        try {
            const r = await axios.get('https://data-api.polymarket.com/positions?user=' + addr);
            const positions = r.data;
            
            if (Array.isArray(positions) && positions.length > 0) {
                console.log('   🎉 FOUND ' + positions.length + ' POSITIONS!');
                positions.forEach(p => {
                    console.log('      - Asset: ' + p.asset);
                    console.log('      - Size:  ' + p.size);
                    console.log('      - Title: ' + (p.title || 'Unknown'));
                });
            } else {
                console.log('   ❌ No Positions found (Array is empty)');
            }
        } catch (e) {
            console.log('   ⚠️  Scan Error: ' + e.message);
        }
    }
}

debug();"