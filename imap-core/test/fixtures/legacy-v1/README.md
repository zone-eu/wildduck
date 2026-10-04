Frozen copies of the MIME indexer files as of commit 3610ab54, the last version that wrote v1 trees
(no `v` property) and rendered them with the old getSize() and rebuild(). Mail stores are full of
trees written by this parser, and their stored `size` and the user quota were computed by this
getSize(). The legacy differential test parses inputs with this parser and requires the current
rebuilder to reproduce what these files produced. Never modify these files.
