cryptMD5-for-javascript
=======================

JavaScript conversion of crypt_md5() (Original by Poul-Henning Kamp)


This is a conversion of crypt_md5() as it can be found in libcrypt.


A hash created by this function will look like this:

    $1$X9U0NCH4$1.cDTvOaCzP41UQ699rOU0
     ^ ^^^^^^^^ ^^^^^^^^^^^^^^^^^^^^^^
     | |        |
     | |        +- Hashed string
     | |
     | +---------- Salt
     |
     +------------ Identifies this as hash based on MD5


The output is compatible with crypt() (using CRYPT_MD5) in PHP: http://www.php.net/manual/en/function.crypt.php


JavaScript:

    var CryptMD5 = require('./cryptmd5.js');

    console.log(CryptMD5.cryptMD5('focus123', 'erXgIjX7'));



PHP:

    echo crypt('focus123', '$1$erXgIjX7');


Will both return

    $1$erXgIjX7$fi/gmab/rku/qc6.ivndo0


(You don't need to specify salt. It will autogenerate a random one if none is present.)