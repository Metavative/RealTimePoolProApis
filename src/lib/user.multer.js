import multer from 'multer'

const profileStorage = multer.memoryStorage();

const userUpload = multer({ profileStorage });

export default userUpload;