function decoderGrib(buffer, maximumPoints = Infinity) {
    if (
        buffer.subarray(0, 4).toString("ascii") !== "GRIB" ||
        buffer[7] !== 2 ||
        buffer.subarray(buffer.length - 4).toString("ascii") !== "7777"
    ) {
        throw new Error("Fichier GRIB2 invalide");
    }

    const sections = {};
    let offset = 16;

    while (offset < buffer.length - 4) {
        const longueur = buffer.readUInt32BE(offset);
        const numero = buffer[offset + 4];

        if (
            longueur < 5 ||
            offset + longueur > buffer.length - 4
        ) {
            throw new Error("Section GRIB invalide");
        }

        sections[numero] = buffer.subarray(
            offset,
            offset + longueur
        );

        offset += longueur;
    }

    const s3 = sections[3];
    const s5 = sections[5];
    const s6 = sections[6];
    const s7 = sections[7];

    if (!s3 || !s5 || !s6 || !s7) {
        throw new Error("Section GRIB manquante");
    }

    const grille = {
        modele: s3.readUInt16BE(12),
        Ni: s3.readUInt32BE(30),
        Nj: s3.readUInt32BE(34),
        latitude_depart: s3.readInt32BE(46) / 1000000,
        longitude_depart: s3.readInt32BE(50) / 1000000,
        resolution_longitude: s3.readUInt32BE(63) / 1000000,
        resolution_latitude: s3.readUInt32BE(67) / 1000000,
        mode_balaye: s3[71]
    };

    if (grille.longitude_depart > 180) {
        grille.longitude_depart -= 360;
    }

    if (grille.modele !== 0 || grille.mode_balaye !== 0) {
        throw new Error("Grille GRIB non prise en charge");
    }

    const nombreValeurs = s5.readUInt32BE(5);
    const modeleCompression = s5.readUInt16BE(9);
    if (nombreValeurs !== grille.Ni * grille.Nj || nombreValeurs > maximumPoints) {
        throw new Error("Nombre de valeurs incompatible avec la grille");
    }

    if (modeleCompression !== 0) {
        throw new Error(
            "Compression GRIB non prise en charge : " +
            modeleCompression
        );
    }

    const reference = s5.readFloatBE(11);

    function facteurSigneMagnitude(valeur) {
        return (valeur & 0x8000)
            ? -(valeur & 0x7FFF)
            : valeur;
    }

    const facteurBinaire = facteurSigneMagnitude(
        s5.readUInt16BE(15)
    );

    const facteurDecimal = facteurSigneMagnitude(
        s5.readUInt16BE(17)
    );

    const bitsParValeur = s5[19];

    if (s6[5] !== 255) {
        throw new Error("Bitmap GRIB non pris en charge");
    }

    const donnees = s7.subarray(5);
    const valeurs = [];

    function lireBits(positionBit, nombreBits) {
        let resultat = 0;

        for (let b = 0; b < nombreBits; b++) {
            const position = positionBit + b;
            const indexOctet = Math.floor(position / 8);
            const indexBit = 7 - (position % 8);

            const bit =
                (donnees[indexOctet] >> indexBit) & 1;

            resultat = resultat * 2 + bit;
        }

        return resultat;
    }

    for (let i = 0; i < nombreValeurs; i++) {
        const entier = bitsParValeur === 0
            ? 0
            : lireBits(i * bitsParValeur, bitsParValeur);

        valeurs.push(
            (
                reference +
                entier * Math.pow(2, facteurBinaire)
            ) * Math.pow(10, -facteurDecimal)
        );
    }

    return { grille, valeurs };
}

module.exports = { decoderGrib };
