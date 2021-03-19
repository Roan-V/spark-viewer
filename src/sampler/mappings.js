import Pbf from 'pbf';
import {
    BukkitMappings,
    McpMappings,
    MojangMappings,
    YarnMappings
} from '../proto';

const MAPPING_DATA_URL = "https://sparkmappings.lucko.me/dist/";

export function resolveMappings(node, mappings) {
    if (!node.className || !node.methodName) {
        return { thread: true }
    }

    if (node.className === "native") {
        return { native: true }
    }

    let { className, methodName } = mappings.func(node) || {};

    let remappedClass = false;
    if (className) {
        remappedClass = true;
    } else {
        className = node.className;
    }

    let remappedMethod = false;
    if (methodName) {
        remappedMethod = true;
    } else {
        methodName = node.methodName;
    }

    let packageName;
    let lambda;

    const packageSplitIdx = className.lastIndexOf('.');
    if (packageSplitIdx !== -1) {
        packageName = className.substring(0, packageSplitIdx + 1);
        className = className.substring(packageSplitIdx + 1);
    }

    const lambdaSplitIdx = className.indexOf("$$Lambda");
    if (lambdaSplitIdx !== -1) {
        lambda = className.substring(lambdaSplitIdx);
        className = className.substring(0, lambdaSplitIdx);
    }

    return { className, methodName, packageName, lambda, remappedClass, remappedMethod }
}

export async function getMappingsInfo() {
    const mappings = await fetch(MAPPING_DATA_URL + "mappings.json");
    return await mappings.json();
}

function detectMappings(info, data) {
    if (!info.auto || !data.metadata) {
        return null;
    }

    const meta = data.metadata;
    if (meta && meta.platform && meta.platform.name && meta.platform.minecraftVersion) {
        const id = meta.platform.name.toLowerCase() + '/' + meta.platform.minecraftVersion;
        return info.auto[id];
    }
    return null;
}

const parseBukkit = buf => BukkitMappings.read(new Pbf(new Uint8Array(buf)));
const parseMcp = buf => McpMappings.read(new Pbf(new Uint8Array(buf)));
const parseMojang = buf => MojangMappings.read(new Pbf(new Uint8Array(buf)));
const parseYarn = buf => YarnMappings.read(new Pbf(new Uint8Array(buf)));

function fetchMappings(version, type, parseFunc) {
    return fetch(MAPPING_DATA_URL + version + '/' + type + '.pbmapping')
        .then(r => r.arrayBuffer())
        .then(parseFunc);
}

export async function requestMappings(type, mappingsInfo, loaded) {
    if (type === 'auto') {
        type = detectMappings(mappingsInfo, loaded);
        if (!type) {
            return _ => {};
        }
    }

    if (type.startsWith("bukkit-mojang")) {
        const version = type.substring("bukkit-mojang-".length);
        const nmsVersion = mappingsInfo.types['bukkit-mojang'].versions[version].nmsVersion;

        const [mojangMappings, bukkitMappings] = await Promise.all([
            fetchMappings(version, 'mojang', parseMojang),
            fetchMappings(version, 'bukkit', parseBukkit)
        ]);

        bukkitGenReverseIndex(bukkitMappings);
        return bukkitRemap(mojangMappings, bukkitMappings, nmsVersion)
    } else if (type.startsWith("bukkit")) {
        const version = type.substring("bukkit-".length);
        const nmsVersion = mappingsInfo.types.bukkit.versions[version].nmsVersion;

        const [mcpMappings, bukkitMappings] = await Promise.all([
            fetchMappings(version, 'mcp', parseMcp),
            fetchMappings(version, 'bukkit', parseBukkit)
        ]);

        bukkitGenReverseIndex(bukkitMappings);
        return bukkitRemap(mcpMappings, bukkitMappings, nmsVersion)
    } else if (type.startsWith("mcp")) {
        const version = type.substring("mcp-".length);

        const mcpMappings = await fetchMappings(version, 'mcp', parseMcp);
        return mcpRemap(mcpMappings)
    } else if (type.startsWith("yarn")) {
        const version = type.substring("yarn-".length);

        const yarnMappings = await fetchMappings(version, 'yarn', parseYarn);
        return yarnRemap(yarnMappings)
    } else {
        return _ => {}
    }
}

// create reverse index for classes by obfuscated name
function bukkitGenReverseIndex(bukkitMappings) {
    const obj = {};
    for (const mapping of Object.values(bukkitMappings.classes)) {
        obj[mapping.obfuscated] = mapping;
    }
    bukkitMappings.classesObfuscated = obj;
}

const bukkitRemap = (outputMappings, bukkitMappings, nmsVersion) => (node) => {
    if (!node.className.startsWith("net.minecraft.server." + nmsVersion + ".")) return {};
    const nmsClassName = node.className.substring(("net.minecraft.server." + nmsVersion + ".").length);

    let bukkitClassData = bukkitMappings.classes[nmsClassName];
    if (nmsClassName === "MinecraftServer") {
        bukkitClassData = bukkitMappings.classes["net.minecraft.server.MinecraftServer"];
    }
    if (!bukkitClassData) return {};

    const obfuscatedClassName = bukkitClassData.obfuscated;
    const outputClassData = outputMappings.classes[obfuscatedClassName];
    if (!outputClassData) return {};

    // if bukkit has already provided a mapping for this method, just return.
    for (const method of bukkitClassData.methods) {
        if (method.mapped === node.methodName) {
            return {};
        }
    }

    let outputMethods = [];
    for (const outputMethod of outputClassData.methods) {
        if (outputMethod.obfuscated === node.methodName) {
            outputMethods.push(mojangMethod);
        }
    }

    if (!outputMethods) return {};

    if (outputMethods.length === 1) {
        const methodName = outputMethods[0].mapped;
        return { methodName };
    }

    const methodDesc = node.methodDesc;
    if (!methodDesc) return {};

    for (const outputMethods of outputMethods) {
        const obfDesc = outputMethods.description;

        // generate the deobfucscated description for the method (obf mojang --> bukkit)
        const deobfDesc = obfDesc.replace(/L([^;]+);/g, function(match) {
            // the obfuscated type name
            const obfType = match.substring(1, match.length - 1);

            // find the mapped bukkit class for the obf'd type.
            const bukkitMapping = bukkitMappings.classesObfuscated[obfType];
            if (bukkitMapping) {
                return "Lnet/minecraft/server/" + nmsVersion + "/" + bukkitMapping.mapped + ";";
            }

            return match;
        });

        // if the description of the method we're trying to remap matches the converted
        // description of the MCP method, we have a match...
        if (methodDesc === deobfDesc) {
            const methodName = outputMethod.mapped;
            return { methodName };
        }
    }

    return {};
}

const mcpRemap = (mcpMappings) => (node) => {
    const methodName = mcpMappings.methods[node.methodName];
    return { methodName };
}

const yarnRemap = (yarnMappings) => (node) => {
    const className = yarnMappings.classes[node.className];
    const methodName = yarnMappings.methods[node.methodName];
    return { className, methodName };
}
