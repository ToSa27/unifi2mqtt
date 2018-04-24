#!/usr/bin/env node

/* eslint-disable camelcase */

const Unifi = require('ubnt-unifi');
const log = require('yalm');
const Mqtt = require('mqtt');
const config = require('./config.js');
const pkg = require('./package.json');

process.title = pkg.name;

log.setLevel(config.verbosity);
log.info(pkg.name + ' ' + pkg.version + ' starting');

let mqttConnected;
let unifiConnected = false;
let retainedClientsTimeout;
let numClients = {};
const retainedClients = [];
const idWifi = {};
const dataWifi = {};
const idDevice = {};
const dataDevice = {};
const macClient = {};

log.info('mqtt trying to connect', config.url);

const mqtt = Mqtt.connect(config.url, {
    will: {topic: config.name + '/connected', payload: '0', retain: true},
    rejectUnauthorized: !config.insecure
});

function mqttPub(topic, payload, options) {
    if (typeof payload === 'object') {
        payload = JSON.stringify(payload);
    }
    log.debug('mqtt >', topic, payload);
    mqtt.publish(topic, payload, options);
}

mqtt.on('connect', () => {
    log.info('mqtt connected', config.url);
    mqttPub(config.name + '/connected', unifiConnected ? '2' : '1', {retain: true});

    log.info('mqtt subscribe', config.name + '/set/#');
    mqtt.subscribe(config.name + '/set/#');

    log.info('mqtt subscribe', config.name + '/status/client/+');
    mqtt.subscribe(config.name + '/status/client/+');
    retainedClientsTimeout = setTimeout(clientsReceived, 2000);
});

mqtt.on('close', () => {
    if (mqttConnected) {
        mqttConnected = false;
        log.info('mqtt closed ' + config.url);
    }
});

mqtt.on('error', err => {
    log.error('mqtt', err);
});

function parsePayload(payload) {
    let val;
    try {
        val = JSON.parse(payload);
        if (typeof val.val !== 'undefined') {
            val = val.val;
        }
    } catch (err) {
        if (val === 'true') {
            val = true;
        } else if (val === 'false') {
            val = false;
        } else if (isNaN(payload)) {
            val = payload;
        } else {
            val = parseFloat(payload);
        }
    }
    return val;
}

function unifiConnect(connected) {
    if (unifiConnected !== connected) {
        unifiConnected = connected;
        mqttPub(config.name + '/connected', unifiConnected ? '2' : '1', {retain: true});
        if (unifiConnected) {
            log.info('unifi connected');
            getWifiNetworks()
                .then(getDevices)
                .then(getClients);
        } else {
            log.info('unifi disconnected');
        }
    }
}

log.info('trying to connect https://' + config.unifiHost + ':' + config.unifiPort);
const unifi = new Unifi({
    host: config.unifiHost,
    port: config.unifiPort,
    username: config.unifiUser,
    password: config.unifiPassword,
    site: config.unifiSite,
    insecure: config.insecure
});

mqtt.on('message', (topic, payload) => {
    payload = payload.toString();
    log.debug('mqtt <', topic, payload);

    const parts = topic.split('/');

    if (parts[1] === 'set' && parts[2] === 'device' && parts[4] === 'led') {
        // Set device led override mode
        let val = parsePayload(payload);
        if (val === 'on' || val === true || ((typeof val === 'number') && val)) {
            val = 'on';
        } else if (val === 'off' || val === false || ((typeof val === 'number') && !val)) {
            val = 'off';
        } else {
            val = 'default';
        }
        if (idDevice[parts[3]]) {
            log.debug('unifi > rest/device/' + idDevice[parts[3]], {led_override: val});
            unifi.put('rest/device/' + idDevice[parts[3]], {led_override: val}).then(getDevices);
        } else {
            log.warn('unknown device', parts[3]);
        }
    } else if (parts[1] === 'set' && parts[2] === 'wifi' && parts[4] === 'enabled') {
        // Set wireless network enable/disable
        if (idWifi[parts[3]]) {
            log.debug('unifi > upd/wlanconf/' + idWifi[parts[3]], {enabled: Boolean(parsePayload(payload))});
            unifi.post('upd/wlanconf/' + idWifi[parts[3]], {enabled: Boolean(parsePayload(payload))}).then(() => {
                setTimeout(getWifiNetworks, 5000);
            });
        } else {
            log.warn('unknown wireless network', parts[3]);
        }
    } else if (parts[1] === 'set' && parts[2] === 'client' && parts[4] === 'blocked') {
        // Block/unblock client
        if (macClient[parts[3]]) {
            log.debug('unifi > cmd/stamgr', {cmd: Boolean(parsePayload(payload)) ? 'block-sta' : 'unblock-sta', mac: macClient[parts[3]]});
            unifi.post('cmd/stamgr', {cmd: Boolean(parsePayload(payload)) ? 'block-sta' : 'unblock-sta', mac: macClient[parts[3]]}).then(() => {
                setTimeout(getClients, 5000);
            });
        } else {
            log.warn('unknown client', parts[3]);
        }
    } else if (parts[1] === 'status' && parts[2] === 'client' && parts[4] === 'connected') {
        // Retained client status
        clearTimeout(retainedClientsTimeout);
        retainedClientsTimeout = setTimeout(clientsReceived, 2000);
        try {
            const val = JSON.parse(payload).val;
            if (val)
                if (!retainedClients.contains(parts[3]))
                    retainedClients.push(parts[3]);
        } catch (err) {
            log.error(topic, payload, err);
        }
    } else if (parts[1] === 'status' && parts[2] === 'client' && parts[4] === 'mac') {
        // Retained client mac
        if (!macClient[parts[3]])
            macClient[parts[3]] = payload;
    }
});

function clientsReceived() {
    log.info('retained clients received');
    log.info('mqtt unsubscribe', config.name + '/status/client/+');
    mqtt.unsubscribe(config.name + '/status/client/+');
    mqttConnected = true;
}

function getWifiNetworks() {
    return new Promise(resolve => {
        log.debug('unifi > rest/wlanconf');
        unifi.get('rest/wlanconf').then(res => {
            res.data.forEach(wifi => {
                dataWifi[wifi._id] = wifi;
                idWifi[wifi.name] = wifi._id;
                mqttPub(config.name + '/status/wifi/' + wifi.name + '/enabled', {val: wifi.enabled}, {retain: true});
            });
            log.debug('unifi got', res.data.length, 'wifi networks');
            resolve();
        });
    });
}

function getDevices() {
    return new Promise(resolve => {
        log.debug('unifi > stat/device');
        unifi.get('stat/device').then(res => {
            res.data.forEach(dev => {
                dataDevice[dev._id] = dev;
                idDevice[dev.name] = dev._id;
                mqttPub(config.name + '/status/device/' + dev.name + '/led', {val: dev.led_override}, {retain: true});
            });
            log.debug('unifi got', res.data.length, 'devices');
            resolve();
        });
    });
}

function getClients() {
    log.debug('getclients', mqttConnected);
    if (!mqttConnected) {
        setTimeout(getClients, 1000);
        return;
    }
    numClients = {};
    log.info('unifi > stat/sta');
    unifi.get('stat/sta').then(clients => {
        clients.data.forEach(client => {
            const id = client.name || client.hostname || client.mac;
            const ssid = client.essid || 'wired';
            if (numClients[ssid]) {
                numClients[ssid] += 1;
            } else {
                numClients[ssid] = 1;
            }
            mqttPub([config.name, 'status', 'client', id, 'connected'].join('/'), {val: true, ts: client.last_seen}, {retain: true});
            mqttPub([config.name, 'status', 'client', id, 'mac'].join('/'), {val: client.mac, ts: client.last_seen}, {retain: true});
            mqttPub([config.name, 'status', 'client', id, 'ip'].join('/'), {val: client.ip, ts: client.last_seen}, {retain: true});
            mqttPub([config.name, 'status', 'client', id, 'guest'].join('/'), {val: client.is_guest, ts: client.last_seen}, {retain: true});
            mqttPub([config.name, 'status', 'client', id, 'wired'].join('/'), {val: client.is_wired, ts: client.last_seen}, {retain: true});
            mqttPub([config.name, 'status', 'client', id, 'ssid'].join('/'), {val: client.essid, ts: client.last_seen}, {retain: true});
            mqttPub([config.name, 'status', 'client', id, 'network'].join('/'), {val: client.network, ts: client.last_seen}, {retain: true});
            mqttPub([config.name, 'status', 'client', id, 'authorized'].join('/'), {val: client.authorized, ts: client.last_seen}, {retain: true});
            mqttPub([config.name, 'status', 'client', id, 'blocked'].join('/'), {val: client.authorized, ts: client.last_seen}, {retain: true});
            mqttPub([config.name, 'status', 'client', id, 'hostname'].join('/'), {val: client.hostname, ts: client.last_seen}, {retain: true});
            mqttPub([config.name, 'status', 'client', id, 'vlan'].join('/'), {val: client.vlan, ts: client.last_seen}, {retain: true});
            const index = retainedClients.indexOf(id);
            if (index > -1)
                retainedClients.splice(index, 1);
            macClient[id] = client.mac;
        });
        retainedClients.forEach(id => {
            mqttPub([config.name, 'status', 'client', id, 'connected'].join('/'), {val: false, ts: (new Date()).getTime()}, {retain: true});
        });
        wifiInfoPub();
    });
}

unifi.on('ctrl.connect', () => {
    unifiConnect(true);
});

unifi.on('ctrl.disconnect', () => {
    unifiConnect(false);
});

unifi.on('ctrl.error', err => {
    log.error(err.message);
});

unifi.on('*.disconnected', data => {
    log.debug('unifi <', data);
    Object.keys(macClient).forEach((id) => {
        if (macClient[id] === data.user)
            mqttPub([config.name, 'status', 'client', id, 'event', 'disconnected'].join('/'), {val: data.user, ts: data.time});
    });
    getClients();
/*
    if (numClients[data.ssid]) {
        numClients[data.ssid] -= 1;
    } else {
        numClients[data.ssid] = 0;
    }
    wifiInfoPub();
    mqttPub([config.name, 'status', 'wifi', data.ssid, 'event', 'disconnected'].join('/'), {val: data.hostname, mac: data.user, ts: data.time});
    mqttPub([config.name, 'status', 'wifi', data.ssid, 'client', data.hostname].join('/'), {val: false, mac: data.user, ts: data.time}, {retain: true});
*/
});

unifi.on('*.connected', data => {
    log.debug('unifi <', data);
    Object.keys(macClient).forEach((id) => {
        if (macClient[id] === data.user)
            mqttPub([config.name, 'status', 'client', id, 'event', 'connected'].join('/'), {val: data.user, ts: data.time});
    });
    getClients();
/*
    if (numClients[data.ssid]) {
        numClients[data.ssid] += 1;
    } else {
        numClients[data.ssid] = 1;
    }
    wifiInfoPub();
    mqttPub([config.name, 'status', 'wifi', data.ssid, 'event', 'connected'].join('/'), {val: data.hostname, mac: data.user, ts: data.time});
    mqttPub([config.name, 'status', 'wifi', data.ssid, 'client', data.hostname].join('/'), {val: true, mac: data.user, ts: data.time}, {retain: true});
*/
});

unifi.on('*.roam', data => {
    log.debug('unifi <', data);
});

unifi.on('*.roam_radio', data => {
    log.debug('unifi <', data);
});

unifi.on('ap.detect_rogue_ap', data => {
    log.debug('unifi <', data);
});

unifi.on('ad.update_available', data => {
    log.debug('unifi <', data);
    mqttPub([config.name, 'event', 'update_available'].join('/'), {val: true, ts: data.time});
    // ToDo : detect once installed and switch back to false?
});

function wifiInfoPub() {
    let sum = 0;
    const ts = (new Date()).getTime();
    Object.keys(idWifi).forEach(ssid => {
        numClients[ssid] = numClients[ssid] || 0;
        sum += numClients[ssid];
        mqttPub([config.name, 'status', 'wifi', ssid, 'clientCount'].join('/'), {val: numClients[ssid], ts}, {retain: true});
        mqttPub([config.name, 'status', 'wifi', ssid, 'enabled'].join('/'), {val: dataWifi[idWifi[ssid]].enabled, ts}, {retain: true});
    });
    mqttPub([config.name, 'status', 'clientCount'].join('/'), {val: sum, ts}, {retain: true});
}
