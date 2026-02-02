const multer = require('multer');
const path = require('path');
const fs = require('fs');
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let folder = 'uploads';
    if (file.fieldname === 'audio') {
      folder = 'uploads/audio';
    } else if (file.fieldname === 'prompts') {
      folder = 'uploads/prompts';
    }
    const dir = path.join(__dirname, `../${folder}`);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(
      null,
      file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname)
    );
  },
});

const upload = multer({ storage });

module.exports = upload;